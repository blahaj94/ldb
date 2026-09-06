import type { ActionButtonProps, ContentDialog, TextField as SeedTextField, UseTextFieldWithGraphemesParams } from '@seed-design/react'
import type { ComponentProps, ReactNode } from 'react'

// #103 Red용 render scaffold. Green 단계에서 고정된 공식 Snippet으로 교체한다.
// Native event는 그대로 연결하며 SEED state/context/focus 동작은 아직 없다.
export function ActionButton({ children, onClick, disabled, type }: ActionButtonProps) {
  return <button type={type} disabled={disabled} onClick={onClick}>{children}</button>
}

type TextFieldProps = Omit<SeedTextField.RootProps, 'onValueChange'> & {
  onValueChange?: UseTextFieldWithGraphemesParams['onValueChange']
  label?: ReactNode
  description?: ReactNode
  errorMessage?: ReactNode
}

export function TextField({ label, description, errorMessage, children }: TextFieldProps) {
  return <div><label>{label}</label>{children}<p>{description}</p><p>{errorMessage}</p></div>
}

export function TextFieldInput(props: ComponentProps<'input'>) {
  return <input {...props} />
}

export function DialogRoot({ children }: ContentDialog.RootProps) {
  return <>{children}</>
}

export function DialogTrigger({ children }: ContentDialog.TriggerProps) {
  return <button type="button">{children}</button>
}

type DialogContentProps = Omit<ContentDialog.ContentProps, 'title'> & { title?: ReactNode }

export function DialogContent({ title, children }: DialogContentProps) {
  return <div role="dialog"><h2>{title}</h2>{children}<button type="button" aria-label="닫기">닫기</button></div>
}
