import type { unstable_StyleProps as SeedStyleProps } from '@seed-design/react'
import type { ComponentPropsWithRef, ComponentType, ElementType } from 'react'
import { ActionButton as SeedActionButton } from './seed/action-button'
import { TextField as SeedTextField, TextFieldInput as SeedTextFieldInput } from './seed/text-field'
import {
  DialogRoot as SeedDialogRoot,
  DialogTrigger as SeedDialogTrigger,
  DialogContent as SeedDialogContent,
  DialogBody as SeedDialogBody,
  DialogFooter as SeedDialogFooter,
  DialogAction as SeedDialogAction
} from './seed/dialog'

// Runtime wrapper 없이 공식 Snippet을 제공하고 화면별 외형 override prop은 공개하지 않는다.
type PublicProps<T extends ElementType> = Omit<ComponentPropsWithRef<T>, 'style' | 'className' | 'fontWeight' | keyof SeedStyleProps>

export type ActionButtonProps = PublicProps<typeof SeedActionButton>
export const ActionButton: ComponentType<ActionButtonProps> = SeedActionButton

export type TextFieldProps = PublicProps<typeof SeedTextField>
export const TextField: ComponentType<TextFieldProps> = SeedTextField
export type TextFieldInputProps = PublicProps<typeof SeedTextFieldInput>
export const TextFieldInput: ComponentType<TextFieldInputProps> = SeedTextFieldInput

export type DialogRootProps = PublicProps<typeof SeedDialogRoot>
export const DialogRoot: ComponentType<DialogRootProps> = SeedDialogRoot
export type DialogTriggerProps = PublicProps<typeof SeedDialogTrigger>
export const DialogTrigger: ComponentType<DialogTriggerProps> = SeedDialogTrigger
export type DialogContentProps = Omit<PublicProps<typeof SeedDialogContent>, 'layerIndex'>
export const DialogContent: ComponentType<DialogContentProps> = SeedDialogContent
export type DialogBodyProps = PublicProps<typeof SeedDialogBody>
export const DialogBody: ComponentType<DialogBodyProps> = SeedDialogBody
export type DialogFooterProps = PublicProps<typeof SeedDialogFooter>
export const DialogFooter: ComponentType<DialogFooterProps> = SeedDialogFooter
export type DialogActionProps = PublicProps<typeof SeedDialogAction>
export const DialogAction: ComponentType<DialogActionProps> = SeedDialogAction

export { default as LayoutBlock } from './seed/layout-01'
export type { LayoutBlockProps } from './seed/layout-01'
export { ContentStack, ExampleSection, SupportingText } from './composition'
