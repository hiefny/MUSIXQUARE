type UiKitStateAction<State> = State | ((previous: State) => State);
type UiKitStateSetter<State> = (action: UiKitStateAction<State>) => void;

interface UiKitMutableRef<Value> {
  current: Value;
}

interface UiKitReactElement {
  readonly __uiKitReactElement: unique symbol;
}

type UiKitReactNode =
  | UiKitReactElement
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly UiKitReactNode[];

interface UiKitComponent<Props> {
  (props: Props): UiKitReactElement | null;
}

interface UiKitReactRuntime {
  readonly Fragment: symbol;
  createElement<Props>(
    type: string | UiKitComponent<Props>,
    props: Props | null,
    ...children: UiKitReactNode[]
  ): UiKitReactElement;
  useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  useRef<Value>(initialValue: Value): UiKitMutableRef<Value>;
  useState<State>(initialState: State | (() => State)): [State, UiKitStateSetter<State>];
}

interface UiKitReactRoot {
  render(node: UiKitReactNode): void;
}

interface UiKitReactDomRuntime {
  createRoot(container: Element | DocumentFragment): UiKitReactRoot;
}

interface UiKitStyle {
  readonly [property: string]: string | number | undefined;
}

interface UiKitDomProps {
  readonly children?: UiKitReactNode;
  readonly className?: string;
  readonly key?: string | number;
  readonly onClick?: (event: MouseEvent) => void;
  readonly style?: UiKitStyle;
}

interface UiKitButtonProps extends UiKitDomProps {
  readonly 'aria-label'?: string;
}

interface UiKitInputChangeEvent {
  readonly currentTarget: HTMLInputElement;
  readonly target: HTMLInputElement;
}

interface UiKitInputProps extends UiKitDomProps {
  readonly defaultValue?: string | number;
  readonly max?: string | number;
  readonly min?: string | number;
  readonly onChange?: (event: UiKitInputChangeEvent) => void;
  readonly type?: string;
  readonly value?: string | number;
}

interface UiKitSvgProps extends UiKitDomProps {
  readonly d?: string;
  readonly fill?: string;
  readonly height?: string | number;
  readonly points?: string;
  readonly viewBox?: string;
  readonly width?: string | number;
  readonly x?: string | number;
  readonly y?: string | number;
}

type UiKitIcon = UiKitComponent<UiKitSvgProps>;

interface UiKitIcons {
  readonly add: UiKitIcon;
  readonly center: UiKitIcon;
  readonly chat: UiKitIcon;
  readonly close: UiKitIcon;
  readonly copy: UiKitIcon;
  readonly help: UiKitIcon;
  readonly home: UiKitIcon;
  readonly left: UiKitIcon;
  readonly list: UiKitIcon;
  readonly next: UiKitIcon;
  readonly pause: UiKitIcon;
  readonly play: UiKitIcon;
  readonly prev: UiKitIcon;
  readonly repeat: UiKitIcon;
  readonly right: UiKitIcon;
  readonly settings: UiKitIcon;
  readonly shuffle: UiKitIcon;
  readonly sub: UiKitIcon;
  readonly sync: UiKitIcon;
  readonly theme: UiKitIcon;
  readonly users: UiKitIcon;
  readonly volume: UiKitIcon;
}

type UiKitRole = 'center' | 'left' | 'right' | 'sub';
type UiKitTab = 'connect' | 'home' | 'playlist' | 'settings';
type UiKitTheme = 'dark' | 'light';
type UiKitReverb = 'Advanced' | 'Arena' | 'Off' | 'Studio';

interface UiKitTrack {
  readonly artist: string;
  readonly dur: string;
  readonly title: string;
}

interface UiKitNowPlayingTrack extends UiKitTrack {
  readonly cur: string;
  readonly progress: number;
}

interface UiKitDevice {
  readonly name: string;
  readonly online: boolean;
  readonly role: string;
}

declare const React: UiKitReactRuntime;
declare const ReactDOM: UiKitReactDomRuntime;

declare namespace JSX {
  type Element = UiKitReactElement;

  interface ElementChildrenAttribute {
    children: unknown;
  }

  interface IntrinsicAttributes {
    readonly key?: string | number;
  }

  interface IntrinsicElements {
    br: UiKitDomProps;
    button: UiKitButtonProps;
    div: UiKitDomProps;
    h2: UiKitDomProps;
    h3: UiKitDomProps;
    header: UiKitDomProps;
    i: UiKitDomProps;
    input: UiKitInputProps;
    nav: UiKitDomProps;
    path: UiKitSvgProps;
    polygon: UiKitSvgProps;
    rect: UiKitSvgProps;
    span: UiKitDomProps;
    svg: UiKitSvgProps;
  }
}

interface Window {
  AppShell: typeof AppShell;
  Connect: typeof Connect;
  Home: typeof Home;
  I: typeof I;
  Playlist: typeof Playlist;
  RoleSetup: typeof RoleSetup;
  React: UiKitReactRuntime;
  ReactDOM: UiKitReactDomRuntime;
  Settings: typeof Settings;
  Start: typeof Start;
  Toast: typeof Toast;
  Wordmark: typeof Wordmark;
}
