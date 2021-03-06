import * as moment from 'moment';
import { sleep } from '../../helpers';
import { IWatcherConfig, Watcher } from '../Watcher';
import { Exchange, OHLCV } from '../../Exchange/Exchange';
import { logger } from '../../../logger';
import { MEASUREMENT_OHLC, MEASUREMENT_OHLC_FILLED } from '../../Influx/constants';

export interface IMarketWatcherConfig extends IWatcherConfig {
  exchange: string;
  base: string;
  quote: string;
  extra: {
    refreshInterval: number;
    maxHistory: string;
  };
}

/**
 * Market watcher class
 * Monitor the specified market:
 *    - get OHLC data and write it to InfluxDB
 *
 * @export
 * @class MarketWatcher
 * @extends {Watcher}
 */
export class MarketWatcher extends Watcher {
  public symbol: string;
  public conf: IMarketWatcherConfig;
  private exchange: Exchange;
  private shouldStop: boolean = false;
  private interval: { id: NodeJS.Timeout | undefined } = { id: undefined };

  constructor(conf: IMarketWatcherConfig) {
    super(conf);
    // Merge with default conf
    this.conf = Object.assign(
      {
        type: 'MarketWatcher',
        extra: {
          refreshInterval: 30000,
          maxHistory: '2018-01-01T00:00:00Z',
        },
      },
      conf
    );
    this.checkConfig(this.conf);
    this.symbol = `${this.conf.base}/${this.conf.quote}`;
    this.exchange = new Exchange({ name: this.conf.exchange });
  }

  public async init(): Promise<void> {
    if (!(await this.exchange.getExchangeInfo(this.symbol))) {
      throw new Error(`[WATCHER] symbol ${this.symbol} doesn't exist on ${this.conf.exchange}`);
    }
  }

  /**
   * Run the watcher
   *
   * @returns {Promise<void>}
   * @memberof MarketWatcher
   */
  public async runWatcher(): Promise<void> {
    logger.info(`[WATCHER] Watcher started on ${this.conf.exchange}: ${this.symbol}`);
    const tags = { base: this.conf.base, quote: this.conf.quote, exchange: this.conf.exchange };
    this.shouldStop = false;
    // Async fill missing data or fetch history (for new series)
    await this.checkTimeserie().catch(error => {
      logger.error(error);
    });
    // Watcher running loop
    while (!this.shouldStop) {
      try {
        // Get last OHLC and write it to influx
        const data: OHLCV[] = await this.exchange.getCandles(this.symbol, {
          limit: 2,
        });
        // Write ohlc async
        this.getInflux()
          .writeOHLC({ base: this.conf.base, quote: this.conf.quote, exchange: this.conf.exchange }, data)
          .catch(error => {
            throw error;
          });
        const start = moment()
          .subtract(100, 'm')
          .utc()
          .format();
        await this.getInflux().refreshOHLCFILLED(tags, true, start);
      } catch (error) {
        logger.error(error);
        throw new Error(`Error while running market watcher loop ${this.conf.exchange} (${this.symbol})`);
      }
      // Sleep (make interval)
      await sleep(this.conf.extra.refreshInterval, this.interval);
    }
  }

  /**
   * Stop the watcher
   *
   * @memberof MarketWatcher
   */
  public async stopWatcher(flushData: boolean): Promise<void> {
    logger.info(`[WATCHER] Watcher stopped on ${this.conf.exchange}: ${this.symbol}`);
    this.shouldStop = true;
    if (this.interval.id) {
      clearTimeout(this.interval.id);
      this.interval.id = undefined;
    }
    if (flushData) {
      const { base, quote, exchange } = this.conf;
      const tags = { base, quote, exchange };
      // Flush all OHLC data
      [MEASUREMENT_OHLC_FILLED, MEASUREMENT_OHLC].forEach(measurement =>
        // flush
        this.getInflux()
          .dropSerie(measurement, tags)
          .catch((error: Error) => logger.error(error))
      );
    }
  }

  /**
   * Check if config allow the watcher creation
   *
   * @private
   * @param {IMarketWatcherConfig} config
   * @memberof MarketWatcher
   */
  private checkConfig(conf: IMarketWatcherConfig) {
    // Can't create MarketWatcher with refreshInterval < 1 second
    if (conf.extra.refreshInterval < 1000) {
      throw new Error('[WATCHER] Cannot create market watcher with refreshInterval < 1000 (1 seconde)');
    }
  }

  /**
   * Check if the time serie already have data (if not fill history, otherwise scan and fill gap)
   *
   * @private
   * @returns {Promise<void>}
   * @memberof MarketWatcher
   */
  private async checkTimeserie(): Promise<void> {
    // If no data founded
    if (
      (await this.getInflux().count(MEASUREMENT_OHLC, {
        base: this.conf.base,
        quote: this.conf.quote,
        exchange: this.conf.exchange,
      })) === 0
    ) {
      await this.fillHistory(this.conf.extra.maxHistory);
    }
    // Else fill missing point by fetching them (exchange)
    else await this.fillGap();
  }

  /**
   * Fill time serie history
   *
   * @private
   * @returns {Promise<void>}
   * @memberof MarketWatcher
   */
  private async fillHistory(from: string): Promise<void> {
    try {
      const batchSize: number = 500;
      const start: moment.Moment = moment(from);
      const end: moment.Moment = moment().subtract(batchSize, 'm');
      let lastCandleFetch: OHLCV | null = null;
      let data: OHLCV[] = [];
      // influx tags
      const tags = { base: this.conf.base, quote: this.conf.quote, exchange: this.conf.exchange };
      while (!this.shouldStop && end.diff(start, 'm') > batchSize) {
        // Fetch missing data and write it to influx
        data = await this.exchange.getCandles(this.symbol, {
          limit: batchSize,
          since: end.toDate().getTime(),
        });
        // If the new data fetched is the same as the last data fetched, there is no more history to fetch, stop...
        if (lastCandleFetch && data[0].time === lastCandleFetch.time) {
          // refresh OHLC with new data
          await this.getInflux().refreshOHLCFILLED(tags, true);
          return;
        }
        await this.getInflux().writeOHLC(tags, data);
        lastCandleFetch = data[0];
        end.subtract(batchSize, 'm');
      }
      // Fetch last point(start + 500)
      data = await this.exchange.getCandles(this.symbol, {
        limit: batchSize,
        since: start.toDate().getTime(),
      });
      await this.getInflux().writeOHLC(tags, data);
      // Refresh ohlcFilled after history retrieve
      await this.getInflux().refreshOHLCFILLED(tags, true);
    } catch (error) {
      logger.error(error);
      throw new Error(`[Watcher] Error when filling history ${this.conf.exchange} (${this.symbol})`);
    }
  }

  /**
   * Fill gap in the timeserie (Will fill missing point when restarting)
   *
   * @private
   * @memberof MarketWatcher
   */
  private async fillGap(): Promise<void> {
    try {
      const tags = { base: this.conf.base, quote: this.conf.quote, exchange: this.conf.exchange };
      // Check if data gap exist for the given symbol (= missing points)
      // return Array of timestamp where data is missing
      const missingPoints = await this.getInflux().getSeriesGap(MEASUREMENT_OHLC, tags, '1m');
      if (missingPoints.length > 0) {
        const batchSize = 500;
        let i = 0;
        // Loop over missigPoints timestamp
        while (!this.shouldStop && i < missingPoints.length) {
          let j = i + 1;
          const start = moment(missingPoints[i]);
          let next = moment(missingPoints[j]);
          // Find consecutive gap (diff between two point = 1 minute)
          while (j < missingPoints.length && Math.abs(start.diff(next, 'm')) < batchSize) {
            // If more than 500 consecutive missing point stop loop to make a request
            // With binance cannot request more than 500 candles
            j++;
            next = moment(missingPoints[j]);
          }
          // Fetch missing data and write it to influx
          const data: OHLCV[] = await this.exchange.getCandles(this.symbol, {
            limit: batchSize,
            since: start.toDate().getTime(),
          });
          if (data.length > 0) {
            await this.getInflux().writeOHLC(tags, data);
            // Also Refresh OHLCFilled
            await this.getInflux().writeOHLC(tags, data, MEASUREMENT_OHLC_FILLED);
          }
          i = j;
        }
        logger.info(
          `[Watcher] ${missingPoints.length} missing points filled into InfluxDB for serie ${this.conf.exchange} (${
            this.symbol
          })`
        );
        // Will refresh gap in OHLC FILLED if needed
        await this.getInflux().refreshOHLCFILLED(tags);
      }
    } catch (error) {
      logger.error(error);
      throw new Error(`[Watcher] Error when filling gap ${this.conf.exchange} (${this.symbol})`);
    }
  }
}
