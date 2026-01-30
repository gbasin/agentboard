import { getProjectColorStyle } from '../utils/projectColor'

interface HostBadgeProps {
  name: string
  className?: string
}

export default function HostBadge({ name, className = '' }: HostBadgeProps) {
  const colorStyle = getProjectColorStyle(`host:${name}`)

  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none tracking-wide ${className}`}
      style={colorStyle}
      title={name}
    >
      {name}
    </span>
  )
}
