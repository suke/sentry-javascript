// tslint:disable:max-classes-per-file
import { Hub } from '@sentry/hub';
import { TransactionContext } from '@sentry/types';
import { timestampWithMs, logger } from '@sentry/utils';

import { Span } from './span';
import { SpanStatus } from './spanstatus';
import { SpanRecorder, Transaction } from './transaction';
import { BrowserTracing } from './integrations/browsertracing';

/**
 * @inheritDoc
 */
class IdleTransactionSpanRecorder extends SpanRecorder {
  private readonly _pushActivity?: (id: string) => void;
  private readonly _popActivity?: (id: string) => void;

  public constructor(maxlen?: number, pushActivity?: (id: string) => void, popActivity?: (id: string) => void) {
    super(maxlen);
    this._pushActivity = pushActivity;
    this._popActivity = popActivity;
  }

  /**
   * @inheritDoc
   */
  public add(span: Span): void {
    span.finish = (endTimestamp?: number) => {
      span.finish(endTimestamp);
      if (this._popActivity) {
        this._popActivity(span.spanId);
      }
    };

    super.add(span);
    if (this._pushActivity) {
      this._pushActivity(span.spanId);
    }
  }
}

/**
 * @inheritDoc
 */
export class IdleTransaction extends Transaction {
  private readonly _idleTimeout: number = 500;
  /**
   * Activities store a list of active spans
   */
  public _activities: Record<string, boolean> = {};

  private _heartbeatTimer: number = 0;

  private _prevHeartbeatString: string | undefined;

  private _heartbeatCounter: number = 0;

  public constructor(transactionContext: TransactionContext, hub?: Hub, idleTimeout: number = 500) {
    super(transactionContext, hub);
    this._idleTimeout = idleTimeout;

    // Start heartbeat so that transactions do not run forever.
    this._pingHeartbeat();
  }

  /**
   * Checks when entries of this._activities are not changing for 3 beats.
   * If this occurs we finish the transaction.
   */
  private _beat(): void {
    clearTimeout(this._heartbeatTimer);
    const keys = Object.keys(this._activities);
    if (keys.length) {
      const heartbeatString = keys.reduce((prev: string, current: string) => prev + current);
      if (heartbeatString === this._prevHeartbeatString) {
        this._heartbeatCounter++;
      } else {
        this._heartbeatCounter = 0;
      }
      if (this._heartbeatCounter >= 3) {
        logger.log(
          `[Tracing] Transaction: ${
            SpanStatus.Cancelled
          } -> Heartbeat safeguard kicked in since content hasn't changed for 3 beats`,
        );
        this.setStatus(SpanStatus.DeadlineExceeded);
        this.setTag('heartbeat', 'failed');
        this._finishIdleTransaction(timestampWithMs());
      }
      this._prevHeartbeatString = heartbeatString;
    }
    this._pingHeartbeat();
  }

  /**
   * Pings the heartbeat
   */
  private _pingHeartbeat(): void {
    this._heartbeatTimer = (setTimeout(() => {
      this._beat();
    }, 5000) as any) as number;
  }

  /**
   * Finish the current active idle transaction
   */
  private _finishIdleTransaction(endTimestamp: number): void {
    if (this.spanRecorder) {
      this.spanRecorder.spans = this.spanRecorder.spans.filter((span: Span) => {
        // If we are dealing with the transaction itself, we just return it
        if (span.spanId === this.spanId) {
          return true;
        }

        // We cancel all pending spans with status "cancelled" to indicate the idle transaction was finished early
        if (!span.endTimestamp) {
          span.endTimestamp = endTimestamp;
          span.setStatus(SpanStatus.Cancelled);
          logger.log('[Tracing] cancelling span since transaction ended early', JSON.stringify(span, undefined, 2));
        }

        const keepSpan = span.startTimestamp < endTimestamp;
        if (!keepSpan) {
          logger.log(
            '[Tracing] discarding Span since it happened after Transaction was finished',
            JSON.stringify(span, undefined, 2),
          );
        }
        return keepSpan;
      });

      logger.log('[Tracing] flushing IdleTransaction');
      this.finish();
    } else {
      logger.log('[Tracing] No active IdleTransaction');
    }
  }

  /**
   * Start tracking a specific activity.
   * @param spanId The span id that represents the activity
   */
  private _pushActivity(spanId: string): void {
    this._activities[spanId] = true;
  }

  /**
   * Remove an activity from usage
   * @param spanId The span id that represents the activity
   */
  private _popActivity(spanId: string): void {
    if (this._activities[spanId]) {
      // tslint:disable-next-line: no-dynamic-delete
      delete this._activities[spanId];
    }

    const count = Object.keys(this._activities).length;
    if (count === 0) {
      const timeout = this._idleTimeout;
      // We need to add the timeout here to have the real endtimestamp of the transaction
      // Remember timestampWithMs is in seconds, timeout is in ms
      const end = timestampWithMs() + timeout / 1000;
      setTimeout(() => {
        this._finishIdleTransaction(end);
      }, timeout);
    }
  }

  /**
   * @inheritDoc
   */
  public initSpanRecorder(maxlen?: number): void {
    if (!this.spanRecorder) {
      // tslint:disable-next-line: no-unbound-method
      this.spanRecorder = new IdleTransactionSpanRecorder(maxlen, this._popActivity, this._pushActivity);
    }
    this.spanRecorder.add(this);
  }
}
