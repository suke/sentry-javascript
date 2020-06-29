import { Hub } from '@sentry/hub';
import { addInstrumentationHandler, getGlobalObject, timestampWithMs } from '@sentry/utils';

import { Transaction } from '../../transaction';

const global = getGlobalObject<Window>();

/**
 * Options for TracingRouter
 */
export interface TracingRouterOptions {
  /**
   * The time to wait in ms until the transaction will be finished. The transaction will use the end timestamp of
   * the last finished span as the endtime for the transaction.
   * Time is in ms.
   *
   * Default: 500
   */
  idleTimeout: number;

  /**
   * Flag to enable/disable creation of `navigation` transaction on history changes. Useful for react applications with
   * a router.
   *
   * Default: true
   */
  startTransactionOnLocationChange: boolean;

  /**
   * Flag to enable/disable creation of `pageload` transaction on first pageload.
   *
   * Default: true
   */
  startTransactionOnPageLoad: boolean;

  /**
   * beforeNavigate is called before a pageload/navigation transaction is created and allows for users
   * to set a custom navigation transaction name based on the current `window.location`. Defaults to returning
   * `window.location.pathname`.
   *
   * If null is returned, a pageload/navigation transaction will not be created.
   *
   * @param name the current name of the pageload/navigation transaction
   */
  beforeNavigate(name: string): string | null;
}

/** JSDOC */
export class TracingRouter {
  /** JSDoc */
  public options: Partial<TracingRouterOptions> = {};

  public constructor(_options?: Partial<TracingRouterOptions>) {
    if (_options) {
      this.options = _options;
    }
  }

  /** JSDOC */
  public startIdleTransaction(hub: Hub, op: string, idleTimeout: number): Transaction | undefined {
    if (!global || !global.location || !hub) {
      return undefined;
    }

    let name: string | null = window.location.pathname;
    if (this.options.beforeNavigate) {
      name = this.options.beforeNavigate(name);

      // if beforeNavigate returns null, we should not start a transaction.
      if (name === null) {
        return undefined;
      }
    }

    const transaction = hub.startTransaction(
      {
        name,
        op,
        trimEnd: true,
      },
      idleTimeout,
    ) as Transaction;

    // We set the transaction here on the scope so error events pick up the trace
    // context and attach it to the error.
    hub.configureScope(scope => scope.setSpan(transaction));

    return transaction;
  }

  /**
   * Start recording pageload/navigation transactions
   * @param hub The hub associated with the pageload/navigation transactions
   * @param idleTimeout The timeout for the transactions
   */
  public init(hub: Hub, idleTimeout: number): void {
    if (this.options.startTransactionOnPageLoad) {
      this.startIdleTransaction(hub, 'pageload', idleTimeout);
    }

    addInstrumentationHandler({
      callback: () => {
        if (this.options.startTransactionOnLocationChange) {
          this.startIdleTransaction(hub, 'navigation', idleTimeout);
        }
      },
      type: 'history',
    });
  }

  /** JSDOC */
  // public static setup(hub: Hub, idleTimeout: number): void {
  //   addInstrumentationHandler({
  //     callback: () => {
  //       if (hub) {
  //         const scope = hub.getScope();
  //         if (scope) {
  //           const activeTransaction = scope.getTransaction();
  //           if (activeTransaction) {
  //             activeTransaction.finish(timestampWithMs());
  //           }
  //         }

  //         if (global && global.location) {
  //           TracingRouter.startIdleTransaction(hub, 'pageload');
  //         }
  //       }
  //     },
  //     type: 'history',
  //   });
  // }

  // /** JSDOC */
  // public static init(hub: Hub, idleTimeout: number): Transaction | undefined {
  //   TracingRouter._idleTimeout = idleTimeout;
  //   return TracingRouter.startIdleTransaction(hub, 'pageload', idleTimeout);
  // }
}

// /**
//  * Creates transaction from navigation changes
//  */
// function historyCallback(_: { [key: string]: any }): void {
//   if (Tracing.options.startTransactionOnLocationChange && global && global.location) {
//     Tracing.finishIdleTransaction(timestampWithMs());
//     Tracing.startIdleTransaction({
//       name: Tracing.options.beforeNavigate(window.location),
//       op: 'navigation',
//     });
//   }
// }
