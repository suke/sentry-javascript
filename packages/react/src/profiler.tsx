import { getCurrentHub } from '@sentry/browser';
import { Integration, IntegrationClass, Span } from '@sentry/types';
import { logger, timestampWithMs } from '@sentry/utils';
import * as hoistNonReactStatic from 'hoist-non-react-statics';
import * as React from 'react';

export const UNKNOWN_COMPONENT = 'unknown';

const TRACING_GETTER = ({
  id: 'Tracing',
} as any) as IntegrationClass<Integration>;

/**
 *
 * Based on implementation from Preact:
 * https:github.com/preactjs/preact/blob/9a422017fec6dab287c77c3aef63c7b2fef0c7e1/hooks/src/index.js#L301-L313
 *
 * Schedule a callback to be invoked after the browser has a chance to paint a new frame.
 * Do this by combining requestAnimationFrame (rAF) + setTimeout to invoke a callback after
 * the next browser frame.
 *
 * Also, schedule a timeout in parallel to the the rAF to ensure the callback is invoked
 * even if RAF doesn't fire (for example if the browser tab is not visible)
 *
 * This is what we use to tell if a component activity has finished
 *
 */
function afterNextFrame(callback: Function): void {
  let timeout: number | undefined;
  let raf: number;

  const done = () => {
    window.clearTimeout(timeout);
    window.cancelAnimationFrame(raf);
    window.setTimeout(callback);
  };

  raf = window.requestAnimationFrame(done);
  timeout = window.setTimeout(done, 100);
}

function warnAboutTracing(name: string): void {
  logger.warn(
    `Unable to profile component ${name} due to invalid Tracing Integration. Please make sure to setup the Tracing integration.`,
  );
}

enum ReactOp {
  Mount = 'mount',
  Visible = 'visible',
}

export type ProfilerProps = {
  name: string;
};

class Profiler extends React.Component<ProfilerProps> {
  public tracingIntegration: Integration | null = getCurrentHub().getIntegration(TRACING_GETTER);
  public mountInfo: {
    activity: number | null;
    span: Span | null;
  } = {
    activity: null,
    span: null,
  };
  public visibleActivity: number | null = null;

  public constructor(props: ProfilerProps) {
    super(props);

    if (this.tracingIntegration === null) {
      warnAboutTracing(props.name);
    } else {
      // tslint:disable-next-line:no-unsafe-any
      const activity = (this.tracingIntegration as any).constructor.pushActivity(props.name, {
        data: {
          update: 0,
        },
        description: `<${props.name}>`,
        op: `react.${ReactOp.Mount}`,
      }) as number;

      if (activity) {
        this.mountInfo.activity = activity;
        // tslint:disable-next-line: no-unsafe-any
        this.mountInfo.span = (this.tracingIntegration as any).constructor.getActivitySpan(activity);
      }
    }
  }

  // If a component mounted, we can finish the mount activity.
  public componentDidMount(): void {
    afterNextFrame(() => {
      if (this.tracingIntegration === null) {
        return;
      }

      if (this.mountInfo.activity) {
        // tslint:disable-next-line:no-unsafe-any
        (this.tracingIntegration as any).constructor.popActivity(this.mountInfo.activity);
        this.mountInfo.activity = null;
      }

      if (this.mountInfo.span) {
        // tslint:disable-next-line:no-unsafe-any
        this.visibleActivity = (this.tracingIntegration as any).constructor.pushActivity(
          this.props.name,
          {
            description: `<${this.props.name}>`,
            op: `react.${ReactOp.Visible}`,
          },
          { parentSpanId: this.mountInfo.span.spanId, canBeCancelled: true },
        ) as number;
      }
    });
  }

  public componentDidUpdate(): void {
    if (this.tracingIntegration !== null && this.mountInfo.span && this.mountInfo.span.data.update) {
      // tslint:disable-next-line:no-unsafe-any
      this.mountInfo.span.setData('update', (this.mountInfo.span.data.update += 1));
    }
  }

  // If a component doesn't mount, the visible activity will be end when the
  // transaction ends.
  public componentWillUnmount(): void {
    afterNextFrame(() => {
      if (this.visibleActivity && this.tracingIntegration !== null) {
        // tslint:disable-next-line:no-unsafe-any
        (this.tracingIntegration as any).constructor.popActivity(this.visibleActivity);
        this.visibleActivity = null;
      }
    });
  }

  public render(): React.ReactNode {
    return this.props.children;
  }
}

/**
 * withProfiler is a higher order component that wraps a
 * component in a {@link Profiler} component.
 *
 * @param WrappedComponent component that is wrapped by Profiler
 * @param name displayName of component being profiled
 */
function withProfiler<P extends object>(WrappedComponent: React.ComponentType<P>, name?: string): React.FC<P> {
  const componentDisplayName = name || WrappedComponent.displayName || WrappedComponent.name || UNKNOWN_COMPONENT;

  const Wrapped: React.FC<P> = (props: P) => (
    <Profiler name={componentDisplayName}>
      <WrappedComponent {...props} />
    </Profiler>
  );

  Wrapped.displayName = `profiler(${componentDisplayName})`;

  // Copy over static methods from Wrapped component to Profiler HOC
  // See: https://reactjs.org/docs/higher-order-components.html#static-methods-must-be-copied-over
  hoistNonReactStatic(Wrapped, WrappedComponent);
  return Wrapped;
}

/**
 *
 * `useProfiler` is a React hook that profiles a React component.
 *
 * Requires React 16.8 or above.
 * @param name displayName of component being profiled
 */
function useProfiler(name: string): void {
  const [mountActivity] = React.useState(() => {
    const tracingIntegration = getCurrentHub().getIntegration(TRACING_GETTER);

    if (tracingIntegration !== null) {
      // tslint:disable-next-line: no-unsafe-any
      return (tracingIntegration as any).constructor.pushActivity(name, {
        description: `<${name}>`,
        op: `react.${ReactOp.Mount}`,
        startTimestamp: timestampWithMs(),
      }) as number;
    }

    warnAboutTracing(name);
    return null;
  });

  const [visibleActivity] = React.useState(() => {
    const tracingIntegration = getCurrentHub().getIntegration(TRACING_GETTER);

    if (tracingIntegration !== null) {
      // tslint:disable-next-line: no-unsafe-any
      return (tracingIntegration as any).constructor.pushActivity(
        name,
        {
          description: `<${name}>`,
          op: `react.${ReactOp.Visible}`,
          startTimestamp: timestampWithMs(),
        },
        { autoPopAfter: 0 },
      ) as number;
    }

    warnAboutTracing(name);
    return null;
  });

  React.useEffect(() => {
    afterNextFrame(() => {
      const tracingIntegration = getCurrentHub().getIntegration(TRACING_GETTER);

      if (tracingIntegration !== null) {
        // tslint:disable-next-line:no-unsafe-any
        (tracingIntegration as any).constructor.popActivity(mountActivity);
      }
    });

    // tslint:disable-next-line: no-void-expression
    return afterNextFrame(() => {
      const tracingIntegration = getCurrentHub().getIntegration(TRACING_GETTER);

      if (tracingIntegration !== null) {
        // tslint:disable-next-line:no-unsafe-any
        (tracingIntegration as any).constructor.popActivity(visibleActivity);
      }
    });
  }, []);
}

export { withProfiler, Profiler, useProfiler };
