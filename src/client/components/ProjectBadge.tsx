import { getProjectColorStyle } from '../utils/projectColor'

interface ProjectBadgeProps {
  name: string
  fullPath?: string
  className?: string
}

/**
 * A pill-styled badge for displaying project names with consistent colors.
 */
export default function ProjectBadge({ name, fullPath, className = '' }: ProjectBadgeProps) {
  const colorStyle = getProjectColorStyle(name)

  return (
    <span
      className={`project-badge inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${className}`}
      style={colorStyle}
      title={fullPath}
    >
      {name}
    </span>
  )
}
