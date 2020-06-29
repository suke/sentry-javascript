import { Hub } from '@sentry/hub';
import { Event, EventProcessor, Integration, Severity, TransactionContext } from '@sentry/types';
import { logger, safeJoin } from '@sentry/utils';

import { SpanStatus } from '../spanstatus';
import { Transaction } from '../transaction';

import { TracingRouter, TracingRouterOptions } from './tracing/router';

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

  private static _activeTransaction?: Transaction;

  public constructor(_options?: Partial<BrowserTracingOptions>) {
    const defaults = {
      beforeNavigate(name: string): string | null {
        return name;
      },
      debug: {
        spanDebugTimingInfo: false,
        writeAsBreadcrumbs: false,
      },
      idleTimeout: 500,
      markBackgroundTransactions: true,
      maxTransactionDuration: 600,
      startTransactionOnLocationChange: true,
      startTransactionOnPageLoad: true,
      tracingOrigins: defaultTracingOrigins,
    };
    BrowserTracing.options = {
      ...defaults,
      ..._options,
    };
  }

  /**
   * Start an idle transaction.
   */
  public static startIdleTransaction(transactionContext: TransactionContext): Transaction | undefined {
    const _getCurrentHub = BrowserTracing._getCurrentHub;
    if (!_getCurrentHub) {
      return undefined;
    }

    const hub = _getCurrentHub();
    if (!hub) {
      return undefined;
    }

    BrowserTracing._activeTransaction = hub.startTransaction(
      {
        trimEnd: true,
        ...transactionContext,
      },
      BrowserTracing.options && BrowserTracing.options.idleTimeout,
    ) as Transaction;

    // We set the transaction here on the scope so error events pick up the trace context and attach it to the error
    hub.configureScope(scope => scope.setSpan(BrowserTracing._activeTransaction));

    return BrowserTracing._activeTransaction;
  }

  /**
   * @inheritDoc
   */
  public setupOnce(addGlobalEventProcessor: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    BrowserTracing._getCurrentHub = getCurrentHub;

    const hub = getCurrentHub();
    if (BrowserTracing.options && BrowserTracing.options.startTransactionOnPageLoad) {
      TracingRouter.startPageloadTransaction(hub, BrowserTracing.options.idleTimeout);
    }

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
