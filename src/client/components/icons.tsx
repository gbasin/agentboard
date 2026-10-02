/**
 * icons - the client's only icon source.
 *
 * Library icons come from the Untitled UI line set, imported by deep
 * `line/esm/<Name>` path: the bundle is the same size as with the barrel
 * (Rollup tree-shakes both), but a deep import loads one module instead of
 * ~1,170 in tests and the dev server. Custom glyphs with no library
 * equivalent live here too, with the same API (SVG props; size through
 * `width`/`height` from ICON_SIZE in controlStyles.ts).
 *
 * Agent/brand logos stay in AgentIcon.tsx. A source-scan test
 * (iconConventions.test.ts) rejects `<svg` and library imports elsewhere.
 */

import type { SVGProps } from 'react'

export { default as AlertTriangleIcon } from '@untitledui-icons/react/line/esm/AlertTriangleIcon'
export { default as ArrowDownIcon } from '@untitledui-icons/react/line/esm/ArrowDownIcon'
export { default as ChevronDownIcon } from '@untitledui-icons/react/line/esm/ChevronDownIcon'
export { default as ChevronRightIcon } from '@untitledui-icons/react/line/esm/ChevronRightIcon'
export { default as ClipboardIcon } from '@untitledui-icons/react/line/esm/ClipboardIcon'
export { default as Copy01Icon } from '@untitledui-icons/react/line/esm/Copy01Icon'
export { default as CornerDownLeftIcon } from '@untitledui-icons/react/line/esm/CornerDownLeftIcon'
export { default as DeleteIcon } from '@untitledui-icons/react/line/esm/DeleteIcon'
export { default as DotsVerticalIcon } from '@untitledui-icons/react/line/esm/DotsVerticalIcon'
export { default as Edit05Icon } from '@untitledui-icons/react/line/esm/Edit05Icon'
export { default as File06Icon } from '@untitledui-icons/react/line/esm/File06Icon'
export { default as FilterFunnel02Icon } from '@untitledui-icons/react/line/esm/FilterFunnel02Icon'
export { default as FolderIcon } from '@untitledui-icons/react/line/esm/FolderIcon'
export { default as GitMergeIcon } from '@untitledui-icons/react/line/esm/GitMergeIcon'
export { default as GitPullRequestIcon } from '@untitledui-icons/react/line/esm/GitPullRequestIcon'
export { default as HandIcon } from '@untitledui-icons/react/line/esm/HandIcon'
export { default as Hash01Icon } from '@untitledui-icons/react/line/esm/Hash01Icon'
export { default as Keyboard01Icon } from '@untitledui-icons/react/line/esm/Keyboard01Icon'
export { default as Menu01Icon } from '@untitledui-icons/react/line/esm/Menu01Icon'
export { default as MinusIcon } from '@untitledui-icons/react/line/esm/MinusIcon'
export { default as Moon01Icon } from '@untitledui-icons/react/line/esm/Moon01Icon'
export { default as MoveIcon } from '@untitledui-icons/react/line/esm/MoveIcon'
export { default as Pencil02Icon } from '@untitledui-icons/react/line/esm/Pencil02Icon'
export { default as PlayIcon } from '@untitledui-icons/react/line/esm/PlayIcon'
export { default as PlusIcon } from '@untitledui-icons/react/line/esm/PlusIcon'
export { default as Settings02Icon } from '@untitledui-icons/react/line/esm/Settings02Icon'
export { default as TerminalIcon } from '@untitledui-icons/react/line/esm/TerminalIcon'
export { default as XCloseIcon } from '@untitledui-icons/react/line/esm/XCloseIcon'

/**
 * Indeterminate arc spinner (spin it with `animate-spin`). Custom: the
 * library's Loading01-03 glyphs are tick bursts that turn to noise when
 * rotated at the 12px this is shown at.
 */
export function SpinnerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
