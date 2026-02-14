import { Toast as BaseToast } from '@base-ui/react/toast'
import { cn } from '../utils/cn'

const DEFAULT_TIMEOUT = 5000

// Global toast manager for use outside React components
export const toastManager = BaseToast.createToastManager()

function ToastItem({ toast }: { toast: BaseToast.Root.ToastObject }) {
  return (
    <BaseToast.Root
      toast={toast}
      className={cn(
        'relative flex w-80 items-start gap-3 border bg-elevated p-4 shadow-lg',
        'data-[swipe=move]:translate-x-[var(--toast-swipe-move-x)]',
        'data-[ending-style]:translate-x-[var(--toast-swipe-end-x)]',
        'data-[ending-style]:opacity-0',
        'data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0',
        'transition-all duration-200',
        toast.type === 'error' && 'border-error/50',
        toast.type === 'success' && 'border-approval/50',
        (!toast.type || toast.type === 'info') && 'border-border'
      )}
    >
      <div className="flex-1 min-w-0">
        <BaseToast.Title
          className={cn(
            'text-sm font-medium',
            toast.type === 'error' && 'text-error',
            toast.type === 'success' && 'text-approval',
            (!toast.type || toast.type === 'info') && 'text-primary'
          )}
        >
          {toast.title}
        </BaseToast.Title>
        {toast.description && (
          <BaseToast.Description className="mt-1 text-xs text-muted line-clamp-2">
            {toast.description}
          </BaseToast.Description>
        )}
      </div>
      <BaseToast.Close
        className="shrink-0 text-muted hover:text-primary transition-colors"
        aria-label="Close"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </BaseToast.Close>
    </BaseToast.Root>
  )
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager()

  return (
    <>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </>
  )
}

export function ToastViewport() {
  return (
    <BaseToast.Provider timeout={DEFAULT_TIMEOUT} toastManager={toastManager}>
      <ToastList />
      <BaseToast.Viewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2" />
    </BaseToast.Provider>
  )
}
