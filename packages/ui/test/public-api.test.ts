import { expectTypeOf, it } from 'vitest'
import type {
  ActionButtonProps,
  DialogBodyProps,
  DialogContentProps,
  TextFieldProps
} from '../src/index'

it('keeps semantic props and refs without exposing appearance overrides', () => {
  expectTypeOf<ActionButtonProps>().toHaveProperty('variant')
  expectTypeOf<ActionButtonProps>().toHaveProperty('size')
  expectTypeOf<ActionButtonProps>().toHaveProperty('ref')
  expectTypeOf<ActionButtonProps>().not.toHaveProperty('style')
  expectTypeOf<ActionButtonProps>().not.toHaveProperty('className')
  expectTypeOf<ActionButtonProps>().not.toHaveProperty('color')
  expectTypeOf<ActionButtonProps>().not.toHaveProperty('fontWeight')
  expectTypeOf<ActionButtonProps>().not.toHaveProperty('bleed')
  expectTypeOf<DialogContentProps>().not.toHaveProperty('width')
  expectTypeOf<DialogContentProps>().not.toHaveProperty('layerIndex')
  expectTypeOf<DialogBodyProps>().not.toHaveProperty('paddingX')
  expectTypeOf<TextFieldProps>().not.toHaveProperty('style')
  expectTypeOf<TextFieldProps>().toHaveProperty('onValueChange')
})
