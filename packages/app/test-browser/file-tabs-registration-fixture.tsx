import { For, Show } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { createSessionTabs } from "../src/pages/session/helpers"
import { FileTabContent } from "../src/pages/session/file-tabs"

// Mirrors the session-side-panel V1 branch with the REAL activation chain: the Tabs
// value is the createSessionTabs activeTab memo (same fallback chain as the app, not a
// raw store read), the list is openedTabs(), and the active file renders through
// FileTabContent under a keyed Show - the app's keyed active view. The tabs store
// itself lives in file-tabs-registration.test.tsx (real openSessionTab reducer +
// persisted/ephemeral double-write apply batch), so registration ordering inside the
// real DOM collection is exercised the way the packaged app hits it.
export function RegistrationPanelFixture(props: {
  canReview: () => boolean
  all: () => string[]
  active: () => string | undefined
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  activate: (tab: string) => void
}) {
  const state = createSessionTabs({
    tabs: () => ({ active: props.active, all: props.all }),
    pathFromTab: props.pathFromTab,
    normalizeTab: props.normalizeTab,
    review: () => true,
    hasReview: props.canReview,
  })
  return (
    <Tabs value={state.activeTab()} onChange={props.activate}>
      <Tabs.List>
        <Show when={props.canReview()}>
          <Tabs.Trigger value="review">
            <div>Review</div>
          </Tabs.Trigger>
        </Show>
        <For each={state.openedTabs()}>
          {(tab) => (
            <Tabs.Trigger value={tab}>
              <div>{tab}</div>
            </Tabs.Trigger>
          )}
        </For>
      </Tabs.List>
      <Show when={state.activeFileTab()} keyed>
        {(tab) => <FileTabContent tab={tab} />}
      </Show>
    </Tabs>
  )
}
