import { describe, it, expect, mock, beforeEach, spyOn, afterEach } from 'bun:test'

// Set DB to memory to avoid filesystem side effects
process.env.AGENTBOARD_DB_PATH = ':memory:'

// Types needed
interface AgentSessionRecord {
    id: number
    sessionId: string
    logFilePath: string
    projectPath: string
    agentType: 'claude' | 'codex'
    displayName: string
    createdAt: string
    lastActivityAt: string
    lastUserMessage: string | null
    currentWindow: string | null
}

// Mock SessionRegistry
const mockRegistry = {
    setAgentSessions: mock(() => {}),
    getAll: mock(() => []),
    getAgentSessions: mock(() => ({ active: [], inactive: [] })),
    on: mock(() => {}),
    replaceSessions: mock(() => {})
}

mock.module('../SessionRegistry', () => ({
    SessionRegistry: mock(() => mockRegistry)
}))

// Mock other dependencies
mock.module('../prerequisites', () => ({
    ensureTmux: () => {}
}))

mock.module('../logPoller', () => ({
    LogPoller: mock(() => ({
        start: mock(() => {}),
        stop: mock(() => {})
    }))
}))

mock.module('../sessionRefreshWorkerClient', () => ({
    SessionRefreshWorkerClient: mock(() => ({
        refresh: mock(async () => []),
        getLastUserMessage: mock(async () => '')
    }))
}))

// Mock Bun.spawnSync
spyOn(Bun, 'spawnSync').mockImplementation(() => ({
    exitCode: 0,
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    pid: 123,
    signalCode: null,
    kill: () => {},
    ref: () => {},
    unref: () => {},
} as any));

// Import the function and the real DB instance
import { hydrateSessionsWithAgentSessions, db } from '../index'
import type { Session } from '../../shared/types'

describe('hydrateSessionsWithAgentSessions', () => {
    // Spies
    let getActiveSessionsSpy: any
    let updateSessionSpy: any
    let orphanSessionSpy: any

    beforeEach(() => {
        // Spy on the real db methods
        getActiveSessionsSpy = spyOn(db, 'getActiveSessions')
        updateSessionSpy = spyOn(db, 'updateSession')
        orphanSessionSpy = spyOn(db, 'orphanSession')

        mockRegistry.setAgentSessions.mockClear()
    })

    afterEach(() => {
        // Restore original implementations to avoid affecting other tests (if any)
        getActiveSessionsSpy.mockRestore()
        updateSessionSpy.mockRestore()
        orphanSessionSpy.mockRestore()
    })

    it('should recover a session when window ID changes but name matches', () => {
        // Setup: DB has a session with old window ID
        const dbSession: AgentSessionRecord = {
            id: 1,
            sessionId: 'session-123',
            logFilePath: '/tmp/log',
            projectPath: '/tmp/project',
            agentType: 'claude',
            displayName: 'MyProject',
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            lastUserMessage: null,
            currentWindow: 'old-window-id:@1'
        }

        getActiveSessionsSpy.mockReturnValue([dbSession])
        // Mock updateSession to return something so it doesn't crash if used
        updateSessionSpy.mockReturnValue(dbSession)

        // Setup: Tmux (sessions input) has a window with matching name but new ID
        const currentTmuxSessions: Session[] = [{
            id: 'new-window-id:@5',
            name: 'MyProject', // Name matches!
            tmuxWindow: 'new-window-id:@5',
            projectPath: '/tmp/project',
            status: 'working',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            agentType: 'claude',
            source: 'managed'
        }]

        // Execute
        hydrateSessionsWithAgentSessions(currentTmuxSessions)

        // Verify
        // 1. Should update the session in DB
        expect(updateSessionSpy).toHaveBeenCalledWith('session-123', {
            currentWindow: 'new-window-id:@5'
        })

        // 2. Should NOT orphan the session
        expect(orphanSessionSpy).not.toHaveBeenCalled()
    })

    it('should orphan a session when window ID changes and name does not match', () => {
        // Setup: DB has two sessions: one to orphan, one valid
        const sessionToOrphan: AgentSessionRecord = {
            id: 1,
            sessionId: 'session-orphan',
            logFilePath: '/tmp/log1',
            projectPath: '/tmp/project',
            agentType: 'claude',
            displayName: 'OrphanProject',
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            lastUserMessage: null,
            currentWindow: 'old-window-id:@1'
        }

        const validSession: AgentSessionRecord = {
            id: 2,
            sessionId: 'session-valid',
            logFilePath: '/tmp/log2',
            projectPath: '/tmp/project',
            agentType: 'claude',
            displayName: 'ValidProject',
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            lastUserMessage: null,
            currentWindow: 'valid-window:@2'
        }

        getActiveSessionsSpy.mockReturnValue([sessionToOrphan, validSession])

        // Setup: Tmux has the valid window + a random other window, but NOT the orphan's matching name
        const currentTmuxSessions: Session[] = [
            {
                id: 'valid-window:@2',
                name: 'ValidProject',
                tmuxWindow: 'valid-window:@2',
                projectPath: '/tmp/project',
                status: 'working',
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                agentType: 'claude',
                source: 'managed'
            },
            {
                id: 'other-window-id:@5',
                name: 'OtherProject', // Name mismatch for session-orphan
                tmuxWindow: 'other-window-id:@5',
                projectPath: '/tmp/project',
                status: 'working',
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                agentType: 'claude',
                source: 'managed'
            }
        ]

        // Execute
        hydrateSessionsWithAgentSessions(currentTmuxSessions)

        // Verify
        // 1. Should orphan the mismatched session
        expect(orphanSessionSpy).toHaveBeenCalledWith('session-orphan')

        // 2. Should NOT update any session (except orphaning)
        expect(updateSessionSpy).not.toHaveBeenCalled()
    })

    it('should safeguard against mass orphaning if all sessions are missing', () => {
        // Setup: DB has 3 sessions
        const dbSessions: AgentSessionRecord[] = [1, 2, 3].map(i => ({
            id: i,
            sessionId: `session-${i}`,
            logFilePath: `/tmp/log${i}`,
            projectPath: '/tmp/project',
            agentType: 'claude',
            displayName: `Project${i}`,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            lastUserMessage: null,
            currentWindow: `window:@${i}`
        } as AgentSessionRecord))

        getActiveSessionsSpy.mockReturnValue(dbSessions)

        // Setup: Tmux is empty (e.g. error listing windows)
        const currentTmuxSessions: Session[] = []

        // Execute
        hydrateSessionsWithAgentSessions(currentTmuxSessions)

        // Verify
        // Should NOT orphan any session due to safeguard
        expect(orphanSessionSpy).not.toHaveBeenCalled()
    })
})
