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
  // Devin mark from devin.ai favicon.svg: interlocking hexagonal knot.
  // Source viewBox is 0 0 425 425; the mark's bounding box is ~x70-357/y49-377,
  // so crop to a centered square for consistent sizing with the other icons.
  return (
    <svg
      viewBox="41 41 343 343"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M70 159.333V91.3471C70 88.3592 71.594 85.5983 74.1816 84.1044L133.043 50.1205C135.631 48.6265 138.819 48.6265 141.407 50.1205L200.269 84.1044C202.856 85.5983 204.45 88.3592 204.45 91.3471V126.068C204.708 137.606 210.806 148.734 221.531 154.926C232.256 161.117 244.942 160.834 255.063 155.289L285.132 137.929C287.719 136.435 290.907 136.435 293.495 137.929L352.357 171.913C354.944 173.406 356.538 176.167 356.538 179.155V247.123C356.538 250.111 354.944 252.872 352.357 254.366L293.495 288.35C290.907 289.844 287.719 289.844 285.132 288.35L255.306 271.13C245.146 265.456 232.344 265.117 221.534 271.358C210.809 277.55 204.711 288.678 204.453 300.215V334.926C204.453 337.914 202.859 340.675 200.271 342.169L141.41 376.153C138.822 377.647 135.634 377.647 133.046 376.153L74.1845 342.169C71.5969 340.675 70.0028 337.914 70.0028 334.926V266.959C70.0029 263.971 71.5969 261.21 74.1845 259.716L133.046 225.732C135.634 224.238 138.822 224.238 141.41 225.732L171.547 243.132C181.656 248.638 194.306 248.906 205.005 242.729C215.815 236.488 221.922 225.231 222.088 213.595C221.83 202.057 215.732 189.737 205.008 183.545C194.283 177.353 181.597 177.636 171.476 183.181L141.269 200.72C138.67 202.229 135.461 202.228 132.864 200.716L74.1576 166.562C71.5835 165.065 70 162.311 70 159.333Z" />
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

function OmpIcon({ className }: { className?: string }) {
  // Official oh-my-pi icon (pi glyph + plugin connector), adapted:
  // glyph renders in currentColor, connector keeps the brand orange.
  // Original viewBox is 120x90 (wide); padded to a square for consistent sizing.
  return (
    <svg
      viewBox="0 -15 120 120"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <rect x="10" y="8" width="100" height="12" rx="2" />
      <rect x="25" y="20" width="12" height="62" rx="2" />
      <rect x="75" y="20" width="12" height="45" rx="2" />
      <rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316" />
      <rect x="76" y="59" width="3" height="8" rx="1" fill="#0d0d0d" />
      <rect x="82" y="59" width="3" height="8" rx="1" fill="#0d0d0d" />
      <circle cx="18" cy="14" r="2" fill="#f97316" opacity="0.8" />
      <circle cx="102" cy="14" r="2" fill="#f97316" opacity="0.8" />
    </svg>
  )
}

type IconComponent = ({ className }: { className?: string }) => JSX.Element

/** Prefix patterns mapped to icons - order matters, first match wins */
const iconPrefixes: [string, IconComponent][] = [
  ['claude', AnthropicIcon],
  ['codex', OpenAIIcon],
  ['omp', OmpIcon],
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
