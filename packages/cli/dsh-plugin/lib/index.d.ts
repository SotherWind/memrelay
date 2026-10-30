export declare const name: string;

export interface PluginContext {
  on(event: string, handler: (payload: unknown) => unknown): unknown;
}

export declare function apply(ctx: PluginContext): void;
