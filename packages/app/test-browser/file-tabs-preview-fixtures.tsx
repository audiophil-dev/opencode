import { onMount, type JSX } from "solid-js"

// JSX-bearing test fixtures for file-tabs-preview.test.tsx. They live in their own module so
// the test's Solid compiler plugin (registered at test-file load) transforms them.

export function MockButton(props: JSX.HTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} />
}

export type SyntheticFindState = {
  focusCalls: number
  registers: number
  visible: Record<string, () => boolean | undefined>
}

type SyntheticProps = {
  file?: { name?: string }
  search?: { register: (handle: { focus: () => void } | null) => void; visible?: () => boolean }
  onLineSelectionEnd?: (range: { start: number; end: number } | null) => void
  onLineNumberSelectionEnd?: (range: { start: number; end: number; side?: string; endSide?: string } | null) => void
  selectedLines?: { start: number; end: number } | null
  annotations?: Array<{ side?: string; metadata: { kind: string; key: string } }>
}

export function createSyntheticFile(state: SyntheticFindState) {
  return function SyntheticFile(props: SyntheticProps) {
    onMount(() => {
      if (!props.search) return
      state.registers += 1
      if (props.search.visible) state.visible[props.file?.name ?? ""] = props.search.visible
      props.search.register({
        focus: () => {
          state.focusCalls += 1
        },
      })
    })

    const selection = () => (props.selectedLines ? JSON.stringify(props.selectedLines) : "")
    const draft = () => props.annotations?.find((item) => item.metadata.kind === "draft")?.metadata.key ?? ""
    const draftSide = () => props.annotations?.find((item) => item.metadata.kind === "draft")?.side ?? ""

    return (
      <div
        data-component="synthetic-file"
        data-synthetic-name={props.file?.name}
        data-synthetic-selection={selection()}
        data-synthetic-draft={draft()}
        data-synthetic-draft-side={draftSide()}
      >
        <button type="button" data-testid="synthetic-end-null" onClick={() => props.onLineSelectionEnd?.(null)}>
          end-null
        </button>
        <button
          type="button"
          data-testid="synthetic-end-range"
          onClick={() => props.onLineSelectionEnd?.({ start: 2, end: 3 })}
        >
          end-range
        </button>
        <button
          type="button"
          data-testid="synthetic-linenumber-end"
          onClick={() =>
            props.onLineNumberSelectionEnd?.({ start: 5, end: 2, side: "additions", endSide: "deletions" })
          }
        >
          linenumber-end
        </button>
      </div>
    )
  }
}
