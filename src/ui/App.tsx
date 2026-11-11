import { For, onCleanup, onMount, Show } from 'solid-js';
import { handleKey, command } from '../commands';
import { AssemblyDialogs, AssemblyEmpty } from '../assembly/ui';
import { booted, doc, setAsideAutosave } from '../store/doc';
import { bootTabs, inAssembly, tabManagerOpen } from '../store/tabs';
import { dismissToast, glProblem, mode, toast, toasts } from '../store/ui';
import { FeatureDialog } from './FeatureDialog';
import { AppearanceDialog } from './Appearance';
import { Palette } from './Palette';
import { AssemblyPanels, Features, Parts, Variables } from './Sidebar';
import { Shortcuts } from './Shortcuts';
import { StatusBar } from './StatusBar';
import { TabBar, TabManager } from './TabBar';
import { TopBar } from './TopBar';
import { Viewport } from './Viewport';

/** If rendering itself fails, this is what's left: the reason, and a way out that doesn't depend on what broke. */
export function Crashed(props: { error: unknown }) {
  return (
    <div class="crashed" role="alert" data-testid="crashed">
      <h1>schmishape stopped</h1>
      <p>{props.error instanceof Error ? props.error.message : String(props.error)}</p>
      <div>
        <button class="btn primary" onClick={() => location.reload()}>Reload</button>
        <button class="btn" onClick={() => { setAsideAutosave(); location.reload(); }}>Reload with a new part</button>
      </div>
    </div>
  );
}

export function App() {
  onMount(() => {
    window.addEventListener('keydown', handleKey);
    bootTabs().catch((e) => toast(`The kernel couldn't start. ${(e as Error).message}`, 'error'));
    onCleanup(() => window.removeEventListener('keydown', handleKey));
  });
  return (
    <div class="app">
      <TopBar />
      <div class="main" classList={{ 'with-tabs': tabManagerOpen() }}>
        <Show when={tabManagerOpen()}><TabManager /></Show>
        <aside class="sidebar">
          <Show when={!inAssembly()} fallback={<AssemblyPanels />}>
            <Features />
            <Parts />
            <Variables />
          </Show>
        </aside>
        <div class="stage">
          <Viewport />
          <FeatureDialog />
          <AppearanceDialog />
          <Show when={booted() && !inAssembly() && doc.features.length === 0 && mode() === 'part' && !glProblem()}>
            <div class="empty" data-testid="empty">
              <p>Right-click a plane to create a sketch.</p>
              <button class="link" onClick={() => void command('example').run()}>Open the example bracket</button>
            </div>
          </Show>
          <Show when={booted() && inAssembly() && !glProblem()}>
            <AssemblyEmpty />
            <AssemblyDialogs />
          </Show>
          <div class="toasts" aria-live="polite">
            <For each={toasts()}>
              {(t) => (
                <div class="toast" classList={{ error: t.kind === 'error' }}>
                  {t.text}
                  <Show when={t.action}>{(a) => <button class="toast-action" onClick={() => { dismissToast(t.id); void a().run(); }}>{a().label}</button>}</Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
      <TabBar />
      <StatusBar />
      <Palette />
      <Shortcuts />
    </div>
  );
}
