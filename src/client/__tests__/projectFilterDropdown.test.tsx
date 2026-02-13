import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import ProjectFilterDropdown from '../components/ProjectFilterDropdown'

const projects = ['/alpha', '/beta', '/gamma']

describe('ProjectFilterDropdown', () => {
  test('shows all-projects label and toggles menu selections', () => {
    const selections: string[][] = []

    const renderer = TestRenderer.create(
      <ProjectFilterDropdown
        projects={projects}
        selectedProjects={[]}
        onSelect={(next) => selections.push(next)}
        hasHiddenPermissions={false}
      />
    )

    const filterButton = renderer.root.findByProps({
      'aria-label': 'Filter by project',
    })
    expect(filterButton.props.title).toBe('All Projects')

    const labelSpan = renderer.root.findByProps({ className: 'truncate' })
    expect(labelSpan.children).toEqual(['All Projects'])

    act(() => {
      filterButton.props.onClick()
    })

    const inputs = renderer.root.findAllByType('input')
    expect(inputs[0]?.props.checked).toBe(true)

    act(() => {
      inputs[1]?.props.onChange()
    })

    expect(selections).toEqual([['/alpha']])

    act(() => {
      inputs[0]?.props.onChange()
    })

    expect(selections).toEqual([['/alpha'], []])

    act(() => {
      renderer.unmount()
    })
  })

  test('maintains project ordering when toggling selections', () => {
    const selections: string[][] = []

    const renderer = TestRenderer.create(
      <ProjectFilterDropdown
        projects={projects}
        selectedProjects={['/beta']}
        onSelect={(next) => selections.push(next)}
        hasHiddenPermissions={false}
      />
    )

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Filter by project' }).props.onClick()
    })

    const inputs = renderer.root.findAllByType('input')

    act(() => {
      inputs[1]?.props.onChange()
    })

    renderer.update(
      <ProjectFilterDropdown
        projects={projects}
        selectedProjects={selections[0] ?? []}
        onSelect={(next) => selections.push(next)}
        hasHiddenPermissions={false}
      />
    )

    const updatedInputs = renderer.root.findAllByType('input')
    act(() => {
      updatedInputs[2]?.props.onChange()
    })

    expect(selections).toEqual([['/alpha', '/beta'], ['/alpha']])

    act(() => {
      renderer.unmount()
    })
  })

  test('shows hidden-permissions dot and clears filters on click', () => {
    const selections: string[][] = []

    const renderer = TestRenderer.create(
      <ProjectFilterDropdown
        projects={projects}
        selectedProjects={['/gamma']}
        onSelect={(next) => selections.push(next)}
        hasHiddenPermissions
      />
    )

    const clearButton = renderer.root.findByProps({
      'aria-label': 'Clear project filters',
    })

    act(() => {
      clearButton.props.onClick({ stopPropagation: () => {} })
    })

    expect(selections).toEqual([[]])

    act(() => {
      renderer.unmount()
    })
  })
})
