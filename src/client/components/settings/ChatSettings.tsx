// ChatSettings.tsx - the Chat tab of the Settings modal: the default approval
// policy for new chat sessions (segmented, design D7), the Claude provider
// environment settings, the chat font size, and the server-persisted
// question auto-answer wait. The drafts live in the modal shell and commit
// on Save (design D5); the auto-answer wait saves itself.
import type { Ref } from 'react'
import type { ChatApprovalPolicy } from '@shared/types'
import ChatProviderSettings, { type ChatProviderSettingsHandle } from '../ChatProviderSettings'
import FontSizeStepper from '../FontSizeStepper'
import QuestionAutoAnswerSetting from './QuestionAutoAnswerSetting'
import {
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
} from '../../stores/settingsStore'

export interface ChatSettingsProps {
  providerSettingsRef: Ref<ChatProviderSettingsHandle>
  onProviderBusyChange: (busy: boolean) => void
  draftDefaultApprovalPolicy: ChatApprovalPolicy
  onDraftDefaultApprovalPolicyChange: (policy: ChatApprovalPolicy) => void
  draftChatFontSize: number
  onDraftChatFontSizeChange: (size: number) => void
}

/** The two policies, in the order they appear in the segmented control. */
const APPROVAL_POLICY_OPTIONS: Array<{ id: ChatApprovalPolicy; label: string }> = [
  { id: 'manual', label: 'Manual' },
  { id: 'auto', label: 'Auto-approve' },
]

export default function ChatSettings({
  providerSettingsRef,
  onProviderBusyChange,
  draftDefaultApprovalPolicy,
  onDraftDefaultApprovalPolicyChange,
  draftChatFontSize,
  onDraftChatFontSizeChange,
}: ChatSettingsProps) {
  return (
    <>
      <ChatProviderSettings ref={providerSettingsRef} onBusyChange={onProviderBusyChange} />

      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          New Chat Sessions
        </label>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Approval Policy</div>
            <div className="text-[10px] text-muted" data-testid="default-approval-policy-hint">
              Default for chats you create. Auto-approve lets tools run without asking.
              Spawned team members use their group&apos;s <code>approval:</code> key, then the team default on the Team page.
            </div>
          </div>
          <div
            className="flex gap-1"
            role="radiogroup"
            aria-label="Default approval policy"
            data-testid="default-approval-policy-select"
          >
            {APPROVAL_POLICY_OPTIONS.map((option, index) => {
              const isActive = draftDefaultApprovalPolicy === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => onDraftDefaultApprovalPolicyChange(option.id)}
                  onKeyDown={(e) => {
                    let newIndex = index
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                      e.preventDefault()
                      newIndex = (index + 1) % APPROVAL_POLICY_OPTIONS.length
                    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      newIndex = (index - 1 + APPROVAL_POLICY_OPTIONS.length) % APPROVAL_POLICY_OPTIONS.length
                    } else {
                      return
                    }
                    const next = APPROVAL_POLICY_OPTIONS[newIndex]!
                    onDraftDefaultApprovalPolicyChange(next.id)
                    e.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[newIndex]
                      ?.focus()
                  }}
                  className={`btn text-xs px-3 focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''}`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          Chat Display
        </label>
        <FontSizeStepper
          label="Chat Font Size"
          hint="Chat text size in pixels (12-20)"
          value={draftChatFontSize}
          min={CHAT_FONT_SIZE_MIN}
          max={CHAT_FONT_SIZE_MAX}
          onChange={onDraftChatFontSizeChange}
        />
      </div>

      {/* The server-persisted question auto-answer wait saves itself with its
          own control (question-auto-answer D5); it is not a modal draft. */}
      <QuestionAutoAnswerSetting />
    </>
  )
}
