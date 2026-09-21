/**
 * AgentIcon - displays an icon based on agent type or command
 * Uses brand logos for Claude (Anthropic) and Codex (OpenAI), falls back to terminal
 */
import { TerminalIcon } from '@untitledui-icons/react/line'
import type { AgentType } from '@shared/types'

interface AgentIconProps {
  agentType?: AgentType
  command?: string
  className?: string
}

function AnthropicIcon({ className }: { className?: string }) {
  // Original viewBox is 92.2x65 (wide). Center it in a square viewBox for consistent sizing.
  // Add padding: (92.2 - 65) / 2 = 13.6 on top/bottom to make it 92.2x92.2
  return (
    <svg
      viewBox="0 0 92.2 92.2"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M66.5,0H52.4l25.7,65h14.1L66.5,0z M25.7,0L0,65h14.4l5.3-13.6h26.9L51.8,65h14.4L40.5,0C40.5,0,25.7,0,25.7,0z M24.3,39.3l8.8-22.8l8.8,22.8H24.3z"
        transform="translate(0, 13.6)"
      />
    </svg>
  )
}

function OpenAIIcon({ className }: { className?: string }) {
  // Original path extends to edges of 24x24 viewBox causing clipping.
  // Expand viewBox and translate path to add padding.
  return (
    <svg
      viewBox="-1 -1 26 26"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

function PiIcon({ className }: { className?: string }) {
  // Greek letter pi (π) from Wikimedia Commons
  return (
    <svg
      viewBox="0 0 588.42 568.88"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M 10.499686,177.03840 L 31.174931,178.56990 C 52.615925,154.32116 61.039171,82.595924 187.38789,96.634671 C 182.79339,403.95560 48.021426,436.37234 56.444675,499.41907 C 59.507674,535.15406 87.840417,557.10556 118.47041,558.38181 C 215.21014,555.06356 210.87089,424.63084 240.99038,95.868921 L 365.80760,95.868921 C 359.17110,211.75239 341.04836,327.63586 339.00636,441.22208 C 340.53786,516.77606 386.48285,557.10556 446.97708,557.61606 C 546.52456,560.93431 577.92030,444.79558 577.92030,395.27709 L 556.47931,395.27710 C 554.43731,436.11709 534.78306,465.47083 492.92207,467.25758 C 378.82535,468.78908 441.61683,266.63113 442.38258,97.400421 L 577.92030,98.166171 L 577.15455,11.636437 C 13.807491,8.9075799 85.312284,-2.1366151 10.499686,177.03840 z" />
    </svg>
  )
}

function DevinIcon({ className }: { className?: string }) {
  // Devin logo mark (from Devin.app sessions-icon.svg): faceted hexagonal "D"
  // Uses brand blue gradients rather than currentColor so it stays recognizable
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <path
        d="M64 302.719C64 333.652 80.64 361.599 106.667 376.532L469.333 585.812V930.772C469.333 945.919 461.227 959.999 448 967.679C434.773 975.359 418.56 975.359 405.333 967.679L85.3333 782.932C72.1067 775.252 64 761.172 64 746.025V302.719Z"
        fill="url(#devin-a)"
      />
      <path
        d="M448 56.3225C461.227 64.0025 469.333 78.0825 469.333 93.2292V585.816L106.667 376.536C80.64 361.603 64 333.656 64 302.723C64 272.216 80.2133 244.056 106.667 228.696L405.333 56.3225C418.56 48.6425 434.773 48.6425 448 56.3225Z"
        fill="url(#devin-b)"
      />
      <path
        d="M618.667 56.3225L938.667 241.069C951.893 248.749 960 262.829 960 277.976V721.283C960 690.349 943.36 662.403 917.333 647.469L554.667 437.976V93.2292C554.667 78.0825 562.773 64.0025 576 56.3225C589.227 48.6425 605.44 48.6425 618.667 56.3225Z"
        fill="url(#devin-c)"
      />
      <path
        d="M554.667 437.974L917.333 647.467C943.36 662.401 960 690.347 960 721.281C960 752.214 943.787 779.947 917.333 795.307L618.667 967.681C605.44 975.361 589.227 975.361 576 967.681C562.773 960.001 554.667 945.921 554.667 930.774V437.974Z"
        fill="url(#devin-d)"
      />
      <defs>
        <linearGradient id="devin-a" x1="469.333" y1="586.667" x2="64" y2="586.667" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1797D9" />
          <stop offset="1" stopColor="#087CBF" />
        </linearGradient>
        <linearGradient id="devin-b" x1="181.333" y1="405.333" x2="394.667" y2="53.3333" gradientUnits="userSpaceOnUse">
          <stop stopColor="#005B9E" />
          <stop offset="1" stopColor="#087CBF" />
        </linearGradient>
        <linearGradient id="devin-c" x1="970.667" y1="166.975" x2="554.667" y2="166.975" gradientUnits="userSpaceOnUse">
          <stop offset="0.0211942" stopColor="#26B2F3" />
          <stop offset="1" stopColor="#3AC6FF" />
        </linearGradient>
        <linearGradient id="devin-d" x1="570.2" y1="973.443" x2="810.667" y2="581.333" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1EA5E6" />
          <stop offset="1" stopColor="#087CBF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function GrokIcon({ className }: { className?: string }) {
  // Grok mark from grok.com favicon.svg (swirl/portal glyph, 512x512)
  return (
    <svg
      viewBox="0 0 512 512"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M210.484 312.759L343.465 210.383C349.984 205.364 359.302 207.322 362.408 215.117C378.758 256.231 371.454 305.64 338.925 339.563C306.397 373.487 261.137 380.927 219.768 363.983L174.577 385.803C239.394 432.008 318.104 420.581 367.289 369.251C406.303 328.564 418.386 273.104 407.088 223.091L407.19 223.198C390.807 149.726 411.218 120.359 453.03 60.3072C454.02 58.8833 455.01 57.4595 456 56L400.978 113.382V113.204L210.45 312.794" />
      <path d="M183.042 337.641C136.519 291.294 144.54 219.567 184.236 178.203C213.59 147.59 261.683 135.096 303.666 153.464L348.755 131.75C340.632 125.627 330.221 119.042 318.275 114.414C264.277 91.2407 199.63 102.774 155.735 148.516C113.513 192.549 100.236 260.254 123.036 318.027C140.069 361.206 112.148 391.748 84.0229 422.575C74.0561 433.503 64.0553 444.431 56 456L183.007 337.677" />
    </svg>
  )
}

type IconComponent = ({ className }: { className?: string }) => JSX.Element

/** Prefix patterns mapped to icons - order matters, first match wins */
const iconPrefixes: [string, IconComponent][] = [
  ['claude', AnthropicIcon],
  ['codex', OpenAIIcon],
  ['pi', PiIcon],
  ['devin', DevinIcon],
  ['grok', GrokIcon],
]

export default function AgentIcon({
  agentType,
  command,
  className = '',
}: AgentIconProps) {
  const key = (agentType || command?.split(' ')[0] || '').toLowerCase()

  for (const [prefix, Icon] of iconPrefixes) {
    if (key.startsWith(prefix)) {
      return <Icon className={className} />
    }
  }

  return <TerminalIcon className={className} />
}
