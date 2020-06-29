import { Hub } from '@sentry/hub';
import { Event, EventProcessor, Integration, Severity, TransactionContext } from '@sentry/types';
import { logger, safeJoin } from '@sentry/utils';

import { SpanStatus } from '../spanstatus';
import { Transaction } from '../transaction';

import { TracingRouter, TracingRouterOptions, RoutingInstrumentation } from './tracing/router';

/**
 * TODO: Figure out Tracing._resetActiveTransaction()
 * TODO: Figure out Tracing.finishIdleTransaction()
 *  - This might be that we monkeypatch it here?
 *  - Ex. say _activeTransaction.finish = () => { finish() and something }
 *  - BrowserTracing wants to hook onto idleTransaction lifecyle, do something before and after
 *  - Should we expose lifecycle hooks?
 *
 * Ex. Router starts a transaction
 * - we then have a function, onCreate() there?
 * - we also pass in a onFinish() there?
 * - I like this because the router is concerned with the pageload/navigation
 * - So react router or angular router would extend TracingRouter, and not worry about
 * - onFinish or onCreate
 * - Actually NO -> this shouldn't work like this
 *
 * - These spans should be on any active transaction right?
 * - The whole point of this is that we should see stuff like
 * - performance marks on any transaction that is on the scope
 * - So we have to be able to register listeners here somehow?
 * - a global "beforeFinish" transaction
 * - This could also be where a user can manually filter to make a nil transaction
 * - Like beforeSend, we have beforeFinish for transactions
 *
 * - Here is how this helps us:
 *  -> we register all our callbacks either at pageload, or on a beforeFinish
 *  -> beforeFinish, we can then make some all the spans have performance marks etc.
 */

/**
 * Options for Browser Tracing integration
 */
export type BrowserTracingOptions = {
  /**
   * List of strings / regex where the integration should create Spans out of. Additionally this will be used
   * to define which outgoing requests the `sentry-trace` header will be attached to.
   *
   * Default: ['localhost', /^\//]
   */
  tracingOrigins: Array<string | RegExp>;

  /**
   * The maximum duration of a transaction before it will be marked as "deadline_exceeded".
   * If you never want to mark a transaction set it to 0.
   * Time is in seconds.
   *
   * Default: 600
   */
  maxTransactionDuration: number;

  /**
   * This is only if you want to debug in prod.
   * writeAsBreadcrumbs: Instead of having console.log statements we log messages to breadcrumbs
   * so you can investigate whats happening in production with your users to figure why things might not appear the
   * way you expect them to.
   *
   * spanDebugTimingInfo: Add timing info to spans at the point where we create them to figure out browser timing
   * issues.
   *
   * You shouldn't care about this.
   *
   * Default: {
   *   writeAsBreadcrumbs: false;
   *   spanDebugTimingInfo: false;
   * }
   */
  debug: {
    writeAsBreadcrumbs: boolean;
    spanDebugTimingInfo: boolean;
  };

  router: RoutingInstrumentation<Record<string, any>>;
} & TracingRouterOptions;

const defaultTracingOrigins = ['localhost', /^\//];

export class BrowserTracing implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'BrowserTracing';

  /**
   * @inheritDoc
   */
  public name: string = BrowserTracing.id;

  /**
   * Browser Tracing integration options
   */
  public static options: BrowserTracingOptions;

  /**
   * Returns current hub.
   */
  private static _getCurrentHub?: () => Hub;

  public constructor(_options?: Partial<BrowserTracingOptions & TracingRouterOptions>) {
    const routerDefaults = {
      beforeNavigate(name: string): string | null {
        return name;
      },
      idleTimeout: 500,
      startTransactionOnLocationChange: true,
      startTransactionOnPageLoad: true,
    };
    const defaults = {
      ...routerDefaults,
      debug: {
        spanDebugTimingInfo: false,
        writeAsBreadcrumbs: false,
      },
      markBackgroundTransactions: true,
      maxTransactionDuration: 600,
      router: new TracingRouter({ ...routerDefaults, ..._options }),
      tracingOrigins: defaultTracingOrigins,
    };
    BrowserTracing.options = {
      ...defaults,
      ..._options,
    };
  }

  /**
   * @inheritDoc
   */
  public setupOnce(addGlobalEventProcessor: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    BrowserTracing._getCurrentHub = getCurrentHub;

    const hub = getCurrentHub();

    // This EventProcessor makes sure that the transaction is not longer than maxTransactionDuration
    addGlobalEventProcessor((event: Event) => {
      const self = getCurrentHub().getIntegration(BrowserTracing);
      if (!self) {
        return event;
      }

      const isOutdatedTransaction =
        event.timestamp &&
        event.start_timestamp &&
        (event.timestamp - event.start_timestamp > BrowserTracing.options.maxTransactionDuration ||
          event.timestamp - event.start_timestamp < 0);

      if (
        BrowserTracing.options.maxTransactionDuration !== 0 &&
        event.type === 'transaction' &&
        isOutdatedTransaction
      ) {
        BrowserTracing._log(`[Tracing] Transaction: ${SpanStatus.Cancelled} since it maxed out maxTransactionDuration`);
        if (event.contexts && event.contexts.trace) {
          event.contexts.trace = {
            ...event.contexts.trace,
            status: SpanStatus.DeadlineExceeded,
          };
          event.tags = {
            ...event.tags,
            maxTransactionDurationExceeded: 'true',
          };
        }
      }

      return event;
    });
  }

  /**
   * Uses logger.log to log things in the SDK or as breadcrumbs if defined in options
   */
  private static _log(...args: any[]): void {
    if (BrowserTracing.options && BrowserTracing.options.debug && BrowserTracing.options.debug.writeAsBreadcrumbs) {
      const _getCurrentHub = BrowserTracing._getCurrentHub;
      if (_getCurrentHub) {
        _getCurrentHub().addBreadcrumb({
          category: 'tracing',
          level: Severity.Debug,
          message: safeJoin(args, ' '),
          type: 'debug',
        });
      }
    }
    logger.log(...args);
  }
}
