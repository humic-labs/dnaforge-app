type Kind = 'invoke' | 'send' | 'reply' | 'event';
type Mount = 'group' | 'root';

type LastIndex<A extends readonly unknown[]> = A extends readonly [...infer H, unknown]
  ? H['length']
  : never;
type OptionalLast<A extends readonly unknown[]> = A extends readonly [...infer H, infer L]
  ? [...H, L?]
  : A;

interface Phantom<Args extends unknown[], Result, Client> {
  readonly args: Args;
  readonly result: Result;
  readonly client: Client;
}

interface DescriptorBase<K extends Kind, Ch extends string | undefined, Cond extends boolean> {
  readonly kind: K;
  readonly channelOverride: Ch;
  readonly conditional: Cond;
}

export interface InvokeDescriptor<
  Args extends unknown[],
  Result,
  Client = (...args: Args) => Promise<Result>,
  Ch extends string | undefined = undefined,
  Cond extends boolean = false,
> extends DescriptorBase<'invoke', Ch, Cond> {
  readonly types?: Phantom<Args, Result, Client>;
  channel<N extends string>(name: N): InvokeDescriptor<Args, Result, Client, N, Cond>;
  conditionallyExposed(): InvokeDescriptor<Args, Result, Client, Ch, true>;
  withDefault<I extends LastIndex<Args>>(
    position: I,
    value: Args[I]
  ): InvokeDescriptor<Args, Result, (...args: OptionalLast<Args>) => Promise<Result>, Ch, Cond>;
}

export interface SendDescriptor<
  Args extends unknown[],
  Ch extends string | undefined = undefined,
  Cond extends boolean = false,
> extends DescriptorBase<'send', Ch, Cond> {
  readonly types?: Phantom<Args, void, (...args: Args) => void>;
  channel<N extends string>(name: N): SendDescriptor<Args, N, Cond>;
  conditionallyExposed(): SendDescriptor<Args, Ch, true>;
}

export interface ReplyDescriptor<
  Args extends unknown[],
  Prefix extends string | undefined = undefined,
> extends DescriptorBase<'reply', Prefix, false> {
  readonly types?: Phantom<Args, void, (requestId: string, ...args: Args) => void>;
  prefix<P extends string>(prefix: P): ReplyDescriptor<Args, P>;
}

export interface EventDescriptor<
  Args extends unknown[],
  Delivered extends unknown[] = Args,
  Ch extends string | undefined = undefined,
> extends DescriptorBase<'event', Ch, false> {
  readonly types?: Phantom<Args, void, (callback: (...delivered: Delivered) => void) => () => void>;
  channel<N extends string>(name: N): EventDescriptor<Args, Delivered, N>;
  projected<D>(project: (...args: Args) => D): EventDescriptor<Args, [D], Ch>;
}

type AnyDescriptor = DescriptorBase<Kind, string | undefined, boolean>;
type Methods = Readonly<Record<string, AnyDescriptor>>;

interface DefaultArgument {
  readonly position: number;
  readonly value: unknown;
}

interface DescriptorState {
  readonly kind: Kind;
  readonly channelOverride: string | undefined;
  readonly conditional: boolean;
  readonly defaultArgument?: DefaultArgument;
  readonly project?: (...args: unknown[]) => unknown;
}

const descriptorStates = new WeakMap<object, DescriptorState>();

function descriptor<D extends AnyDescriptor>(state: DescriptorState): D {
  const next = (patch: Partial<DescriptorState>) =>
    descriptor<AnyDescriptor>({ ...state, ...patch });
  const built: AnyDescriptor = Object.freeze({
    kind: state.kind,
    channelOverride: state.channelOverride,
    conditional: state.conditional,
    channel: (name: string) => next({ channelOverride: name }),
    prefix: (prefix: string) => next({ channelOverride: prefix }),
    conditionallyExposed: () => next({ conditional: true }),
    withDefault: (position: number, value: unknown) =>
      next({ defaultArgument: { position, value } }),
    projected: (project: (...args: unknown[]) => unknown) => next({ project }),
  });
  descriptorStates.set(built, state);
  return built as D;
}

const initial = (kind: Kind): DescriptorState => ({
  kind,
  channelOverride: undefined,
  conditional: false,
});

type SignatureArgs<S> = S extends (...args: infer A) => Promise<unknown> ? A : never;
type SignatureResult<S> = S extends (...args: never[]) => Promise<infer R> ? R : never;

export const invoke = <Args extends unknown[], Result>(): InvokeDescriptor<Args, Result> =>
  descriptor(initial('invoke'));
export const invokeGeneric = <
  Signature extends (...args: never[]) => Promise<unknown>,
>(): InvokeDescriptor<SignatureArgs<Signature>, SignatureResult<Signature>, Signature> =>
  descriptor(initial('invoke'));
export const send = <Args extends unknown[]>(): SendDescriptor<Args> => descriptor(initial('send'));
export const reply = <Args extends unknown[]>(): ReplyDescriptor<Args> =>
  descriptor(initial('reply'));
export const event = <Args extends unknown[]>(): EventDescriptor<Args> =>
  descriptor(initial('event'));

export interface ContractEntry {
  readonly method: string;
  readonly kind: Kind;
  readonly channel: string;
  readonly conditional: boolean;
  readonly defaultArgument?: DefaultArgument;
  readonly project?: (...args: unknown[]) => unknown;
}

export interface ContractGroup<G extends string, M extends Methods> {
  readonly name: G;
  readonly mount: Mount;
  readonly methods: M;
  readonly entries: ReadonlyArray<ContractEntry>;
}
export type AnyContractGroup = ContractGroup<string, Methods>;

export function defineGroup<const G extends string, const M extends Methods>(
  name: G,
  methods: M,
  options?: { readonly mount?: Mount }
): ContractGroup<G, M> {
  const entries = Object.entries(methods).map(([method, d]): ContractEntry => {
    const state = descriptorStates.get(d);
    if (!state) throw new Error(`${name}.${method} was not built by an IPC contract builder`);
    const fallback = state.kind === 'reply' ? `${name}:${method}:` : `${name}:${method}`;
    return Object.freeze({
      method,
      kind: state.kind,
      channel: state.channelOverride ?? fallback,
      conditional: state.conditional,
      ...(state.defaultArgument ? { defaultArgument: state.defaultArgument } : {}),
      ...(state.project ? { project: state.project } : {}),
    });
  });
  const channels = new Set<string>();
  for (const entry of entries) {
    if (channels.has(entry.channel))
      throw new Error(`${name} declares channel ${entry.channel} twice`);
    channels.add(entry.channel);
  }
  for (const reply of entries.filter(({ kind }) => kind === 'reply')) {
    const shadowed = entries.find(
      (entry) => entry !== reply && entry.channel.startsWith(reply.channel)
    );
    if (shadowed)
      throw new Error(`${name}.${reply.method} reply prefix also matches ${shadowed.channel}`);
  }
  return Object.freeze({
    name,
    mount: options?.mount ?? 'group',
    methods,
    entries: Object.freeze(entries),
  });
}

export function contractEntries(group: AnyContractGroup): ReadonlyArray<ContractEntry> {
  return group.entries;
}

type Simplify<T> = { [K in keyof T]: T[K] };
type MethodsOf<C extends AnyContractGroup> = C['methods'];
type ConditionalKeys<M extends Methods> = {
  [K in keyof M]: M[K]['conditional'] extends true ? K : never;
}[keyof M];
type ClientMethod<D> = D extends {
  readonly types?: Phantom<infer _Args extends unknown[], infer _Result, infer Client>;
}
  ? Client
  : never;

export type ConditionalMethodsOf<C extends AnyContractGroup> = ConditionalKeys<MethodsOf<C>>;

export type ClientOf<C extends AnyContractGroup> = Simplify<
  {
    readonly [K in Exclude<keyof MethodsOf<C>, ConditionalKeys<MethodsOf<C>>>]: ClientMethod<
      MethodsOf<C>[K]
    >;
  } & {
    readonly [K in ConditionalKeys<MethodsOf<C>>]?: ClientMethod<MethodsOf<C>[K]>;
  }
>;

export interface HandlerResult<_Method extends string, Result> extends Promise<Result> {}
export type InvokeHandler<Method extends string, Args extends unknown[], Result, Event> = (
  event: Event,
  ...args: Args
) => Result | HandlerResult<Method, Result>;
export type SendHandler<_Method extends string, Args extends unknown[], Event> = (
  event: Event,
  ...args: Args
) => void;

type NullWhen<Cond> = Cond extends true ? null : never;
type HandlerFor<K extends string, D, InvokeEvent, SendEvent> = D extends {
  readonly kind: 'invoke';
  readonly conditional: infer Cond;
  readonly types?: Phantom<infer A extends unknown[], infer R, unknown>;
}
  ? InvokeHandler<K, A, R, InvokeEvent> | NullWhen<Cond>
  : D extends {
        readonly kind: 'send';
        readonly conditional: infer Cond;
        readonly types?: Phantom<infer A extends unknown[], void, unknown>;
      }
    ? SendHandler<K, A, SendEvent> | NullWhen<Cond>
    : never;
type HandledKeys<M extends Methods> = {
  [K in keyof M]: M[K]['kind'] extends 'invoke' | 'send' ? K : never;
}[keyof M];

type SharedGroupMethods<
  C extends AnyContractGroup,
  Rest extends readonly AnyContractGroup[],
  Found = never,
> = Rest extends readonly [
  infer Head extends AnyContractGroup,
  ...infer Tail extends readonly AnyContractGroup[],
]
  ? SharedGroupMethods<
      C,
      Tail,
      | Found
      | (Head['name'] extends C['name']
          ? Extract<keyof Head['methods'], keyof C['methods']>
          : never)
    >
  : Found;

export type DuplicateGroupMethods<
  Cs extends readonly AnyContractGroup[],
  Found extends string = never,
> = Cs extends readonly [
  infer Head extends AnyContractGroup,
  ...infer Tail extends readonly AnyContractGroup[],
]
  ? DuplicateGroupMethods<
      Tail,
      Found | `${Head['name']}.${SharedGroupMethods<Head, Tail> & string}`
    >
  : Found;

export type DisjointGroups<Cs extends readonly AnyContractGroup[]> = [
  DuplicateGroupMethods<Cs>,
] extends [never]
  ? true
  : { readonly duplicateMethods: DuplicateGroupMethods<Cs> };

export type AssertTrue<T extends true> = T;

export type HandlersOf<C extends AnyContractGroup, InvokeEvent, SendEvent> = {
  readonly [K in HandledKeys<MethodsOf<C>> & string]: HandlerFor<
    K,
    MethodsOf<C>[K],
    InvokeEvent,
    SendEvent
  >;
};

export type ReplyArgsOf<
  C extends AnyContractGroup,
  K extends keyof MethodsOf<C>,
> = MethodsOf<C>[K] extends {
  readonly kind: 'reply';
  readonly types?: Phantom<infer A extends unknown[], void, unknown>;
}
  ? A
  : never;
export type ReplyMethodsOf<C extends AnyContractGroup> = {
  [K in keyof MethodsOf<C>]: MethodsOf<C>[K]['kind'] extends 'reply' ? K : never;
}[keyof MethodsOf<C>] &
  string;

type ChannelOf<G extends string, K, D> = D extends {
  readonly channelOverride: infer O extends string;
}
  ? O
  : D extends { readonly kind: 'reply' }
    ? `${G}:${K & string}:`
    : `${G}:${K & string}`;
type EntriesOf<C extends AnyContractGroup> = {
  [K in keyof MethodsOf<C>]: MethodsOf<C>[K] extends infer D extends AnyDescriptor
    ? D extends { readonly types?: Phantom<infer A extends unknown[], infer R, unknown> }
      ? { kind: D['kind']; channel: ChannelOf<C['name'], K, D>; args: A; result: R }
      : never
    : never;
}[keyof MethodsOf<C>];
type RegistryEntries<R extends readonly AnyContractGroup[]> = R[number] extends infer C
  ? C extends AnyContractGroup
    ? EntriesOf<C>
    : never
  : never;

export type ContractInvokeMap<R extends readonly AnyContractGroup[]> = {
  [E in Extract<RegistryEntries<R>, { kind: 'invoke' }> as E['channel']]: {
    args: E['args'];
    result: E['result'];
  };
};
export type ContractSendMap<R extends readonly AnyContractGroup[]> = {
  [E in Extract<RegistryEntries<R>, { kind: 'send' }> as E['channel']]: { args: E['args'] };
};
export type ContractEventMap<R extends readonly AnyContractGroup[]> = {
  [E in Extract<RegistryEntries<R>, { kind: 'event' }> as E['channel']]: { args: E['args'] };
};
export type ContractReplyChannel<R extends readonly AnyContractGroup[]> =
  `${Extract<RegistryEntries<R>, { kind: 'reply' }>['channel']}${string}`;

export type ForwardTarget<C extends AnyContractGroup> = {
  readonly [K in keyof ClientOf<C>]: NonNullable<ClientOf<C>[K]> extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => R
    : never;
};

export function forwardGroup<C extends AnyContractGroup>(
  contract: C,
  target: () => ForwardTarget<C> | undefined
): ClientOf<C> {
  const lookup = (method: string): unknown => {
    const current: Readonly<Record<string, unknown>> | undefined = target();
    return current?.[method];
  };
  const forwarder =
    (method: string) =>
    (...args: unknown[]): unknown => {
      const fn = lookup(method);
      if (typeof fn !== 'function')
        throw new Error(`${contract.name}.${method} is unavailable on this platform`);
      return fn(...args);
    };
  const forwarders: Record<string, unknown> = {};
  for (const { method, conditional } of contractEntries(contract)) {
    if (conditional) {
      Object.defineProperty(forwarders, method, {
        enumerable: true,
        get: () => (typeof lookup(method) === 'function' ? forwarder(method) : undefined),
      });
    } else {
      forwarders[method] = forwarder(method);
    }
  }
  return Object.freeze(forwarders) as ClientOf<C>;
}
