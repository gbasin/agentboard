# Session Filters Implementation Plan

## Overview

Add project-based filtering to the sessions sidebar, with a compact dropdown UI and persistence. Include an orange notification dot when filtered-out **active** sessions need permission.

## Requirements

- Dropdown in sidebar header next to session count
- "All Projects" as default, plus dynamic list from current sessions
- Filter applies to both active and inactive sessions
- Persist selection to localStorage (and optionally sync to URL)
- Orange dot indicator when hidden **active** sessions have `permission` status
- Click dot to clear filter
- Keyboard accessible with proper ARIA attributes

---

## Open Questions

### URL State Sync

Should filter be reflected in URL for shareability/bookmarking?

**Option A: localStorage only (simpler)**
- Filter persists per-browser
- No URL clutter
- Can't share filtered view

**Option B: URL query param (more flexible)**
- `?project=/path/to/project` or `?project=encoded-name`
- Shareable/bookmarkable filtered views
- Needs URL encoding for paths with special chars
- Could sync bidirectionally with localStorage

**Recommendation:** Start with localStorage, add URL sync later if needed. Structure the store setter to make this easy to add.

---

## Implementation Steps

### 1. Update Settings Store

**File:** `src/client/stores/settingsStore.ts`

Add new persisted state:

```ts
interface SettingsState {
  // ... existing
  projectFilter: string | null  // null = "All Projects"
  setProjectFilter: (filter: string | null) => void
}
```

- Add to the persisted zustand store
- Default value: `null`

---

### 2. Create Filter Dropdown Component

**File:** `src/client/components/ProjectFilterDropdown.tsx` (new)

Props:
```ts
interface ProjectFilterDropdownProps {
  projects: string[]              // unique project paths
  selectedProject: string | null  // current filter
  onSelect: (project: string | null) => void
  hasHiddenPermissions: boolean   // show orange dot
}
```

Implementation:
- Use a `<select>` or custom dropdown (match existing UI patterns)
- First option: "All Projects"
- Remaining options: project display names
- Truncate long names in trigger, show full path on hover/title
- Orange dot positioned top-right of dropdown when `hasHiddenPermissions && selectedProject !== null`

**Accessibility:**
- If using native `<select>`: keyboard accessible by default
- If custom dropdown:
  - `role="listbox"` on menu, `role="option"` on items
  - `aria-label="Filter by project"`
  - `aria-expanded` on trigger
  - Arrow key navigation
  - Escape to close
  - Focus management on open/close

**Duplicate folder name handling:**
- Create utility function `getProjectDisplayNames(paths: string[]): Map<string, string>`
- If leaf names are unique, use leaf (e.g., "api")
- If duplicates exist, walk up path until unique (e.g., "work/api", "personal/api")

---

### 3. Add Project Extraction Utility

**File:** `src/client/utils/sessions.ts`

```ts
export function getUniqueProjects(
  sessions: Session[],
  inactiveSessions: AgentSession[]
): string[] {
  const paths = new Set<string>()

  for (const s of sessions) {
    if (s.projectPath) paths.add(s.projectPath)
  }
  for (const s of inactiveSessions) {
    if (s.projectPath) paths.add(s.projectPath)
  }

  return Array.from(paths).sort()
}
```

- Extract `projectPath` from both arrays
- Dedupe and sort alphabetically
- Memoize in component to avoid recalc on every render

**Note:** Path normalization is already done server-side in `logDiscovery.ts` before paths are sent to the client.

---

### 4. Add Display Name Utility

**File:** `src/client/utils/sessionLabel.ts` (extend existing)

```ts
export function getDisambiguatedProjectNames(
  paths: string[]
): Map<string, string>
```

- Input: array of full project paths
- Output: map from full path → display name
- Logic: start with leaf, add parent segments only where needed to disambiguate

---

### 5. Update SessionList Component

**File:** `src/client/components/SessionList.tsx`

**Changes:**

1. Import new components/utilities
2. Get filter state from settings store:
   ```ts
   const projectFilter = useSettingsStore((state) => state.projectFilter)
   const setProjectFilter = useSettingsStore((state) => state.setProjectFilter)
   ```

3. Extract unique projects (memoized):
   ```ts
   const uniqueProjects = useMemo(
     () => getUniqueProjects(sessions, inactiveSessions),
     [sessions, inactiveSessions]
   )
   ```

4. Filter sessions:
   ```ts
   const filteredSessions = useMemo(() => {
     if (!projectFilter) return sortedSessions
     return sortedSessions.filter(s => s.projectPath === projectFilter)
   }, [sortedSessions, projectFilter])

   const filteredInactiveSessions = useMemo(() => {
     if (!projectFilter) return inactiveSessions
     return inactiveSessions.filter(s => s.projectPath === projectFilter)
   }, [inactiveSessions, projectFilter])
   ```

5. Calculate hidden permission count (**active sessions only**):
   ```ts
   const hiddenPermissionCount = useMemo(() => {
     if (!projectFilter) return 0
     return sortedSessions.filter(
       s => s.projectPath !== projectFilter && s.status === 'permission'
     ).length
   }, [sortedSessions, projectFilter])
   ```

6. Clear invalid filter on load:
   ```ts
   useEffect(() => {
     if (projectFilter && !uniqueProjects.includes(projectFilter)) {
       setProjectFilter(null)
     }
   }, [projectFilter, uniqueProjects, setProjectFilter])
   ```

7. Update header JSX:
   ```tsx
   <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
     <span className="text-xs font-medium uppercase tracking-wider text-muted">
       Sessions
     </span>
     <div className="flex items-center gap-2">
       <ProjectFilterDropdown
         projects={uniqueProjects}
         selectedProject={projectFilter}
         onSelect={setProjectFilter}
         hasHiddenPermissions={hiddenPermissionCount > 0}
       />
       <span className="text-xs text-muted">
         {filteredSessions.length}
       </span>
     </div>
   </div>
   ```

8. Replace `sortedSessions` → `filteredSessions` in render
9. Replace `inactiveSessions` → `filteredInactiveSessions` in render
10. Update inactive section count to show filtered count

---

### 6. Handle Orange Dot Click

In `ProjectFilterDropdown`:
- When dot is clicked, call `onSelect(null)` to clear filter
- Add `title="Hidden sessions need attention"` for tooltip on hover

---

### 7. Styling

**File:** `src/client/styles/index.css` (or component styles)

- Orange dot: `bg-approval` (already exists for permission status)
- Size: ~6-8px circle
- Position: absolute, top-right corner of dropdown trigger
- Animation: subtle pulse (reuse existing `pulse-approval` if appropriate)

---

## Edge Cases Handled

| Case | Solution |
|------|----------|
| Duplicate folder names | Disambiguate with parent path segments |
| Selected project gone | Clear filter on load if invalid |
| Very long project list | Scrollable dropdown with max-height |
| Mobile viewport | Truncate names, use native select if needed |
| Rapid session changes | Memoize project extraction |
| Permission + filtered | Orange dot (active only), click to clear |
| Path normalization | Already handled server-side in `logDiscovery.ts` |

---

## Testing

1. **Unit tests** (`src/client/utils/`)
   - `getUniqueProjects` - deduplication, sorting
   - `getDisambiguatedProjectNames` - various duplicate scenarios

2. **Manual/integration testing**
   - Filter persists across refresh
   - Filter clears when project no longer exists
   - Orange dot appears only for hidden active permission sessions
   - Orange dot does NOT appear for inactive sessions with permission
   - Inactive sessions filter correctly
   - Session count updates with filter
   - Keyboard navigation works (Tab, Enter, Escape, arrows)
   - Screen reader announces filter state

---

## Future Extensions

- URL sync for shareable filtered views
- Status filter (working/waiting/permission) - add `statusFilter: SessionStatus[] | null` to store
- Search/filter within long project dropdown
- Filter presets / saved filters

---

## Files Changed

| File | Change |
|------|--------|
| `src/client/stores/settingsStore.ts` | Add `projectFilter` state |
| `src/client/components/ProjectFilterDropdown.tsx` | New component |
| `src/client/components/SessionList.tsx` | Integrate filter |
| `src/client/utils/sessions.ts` | Add `getUniqueProjects` |
| `src/client/utils/sessionLabel.ts` | Add `getDisambiguatedProjectNames` |
| `src/client/styles/index.css` | Orange dot styles (if needed) |
