import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ActionButton, DialogContent, DialogRoot, DialogTrigger, TextField, TextFieldInput
} from '../src/index'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(children: ReactNode) {
  await act(async () => root.render(children))
}

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector)
  const isMissing = result == null
  if (isMissing) throw new Error(`Test setup: expected rendered element ${selector}`)
  return result
}

async function click(button: HTMLElement) {
  await act(async () => button.click())
}

describe('ActionButton interaction', () => {
  it('forwards each enabled activation to the consumer callback', async () => {
    const onClick = vi.fn()
    await render(<ActionButton onClick={onClick}>Run</ActionButton>)

    await click(element('button'))

    expect(onClick).toHaveBeenCalledOnce()
  })

  it('blocks a disabled button activation', async () => {
    const onClick = vi.fn()
    await render(<ActionButton disabled onClick={onClick}>Run</ActionButton>)

    await click(element('button'))

    expect(onClick).not.toHaveBeenCalled()
  })

  it('blocks a loading button activation without changing its label', async () => {
    const onClick = vi.fn()
    await render(<ActionButton loading onClick={onClick}>Run</ActionButton>)

    await click(element('button'))

    expect(onClick).not.toHaveBeenCalled()
    expect(element('button').textContent).toContain('Run')
  })
})

describe('TextField interaction and accessible connections', () => {
  it('connects its visible label to the editable input', async () => {
    await render(<TextField label="Display name"><TextFieldInput /></TextField>)
    const input = element<HTMLInputElement>('input')
    const label = element<HTMLLabelElement>('label')

    expect(label.control).toBe(input)
  })

  it('reports edited value to the controlled consumer and reflects its next value', async () => {
    const onValueChange = vi.fn()
    function ControlledField() {
      const [value, setValue] = useState('')
      return (
        <TextField label="Display name" value={value} onValueChange={(details) => {
          onValueChange(details.value)
          setValue(details.value.toUpperCase())
        }}><TextFieldInput /></TextField>
      )
    }
    await render(<ControlledField />)
    const input = element<HTMLInputElement>('input')
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    const isSetterMissing = valueSetter == null
    if (isSetterMissing) throw new Error('Test setup: native input value setter unavailable')

    await act(async () => {
      valueSetter.call(input, 'New name')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('New name')
    expect(input.value).toBe('NEW NAME')
  })

  it('connects invalid state, description and error to the input', async () => {
    await render(
      <TextField label="Display name" invalid description="Use a neutral name" errorMessage="Name required">
        <TextFieldInput />
      </TextField>
    )
    const input = element<HTMLInputElement>('input')

    expect(input.getAttribute('aria-invalid')).toBe('true')
    const describedIds = input.getAttribute('aria-describedby')?.split(/\s+/) ?? []
    const descriptions = describedIds.map((id) => document.getElementById(id)?.textContent)
    expect(descriptions.join(' ')).toContain('Use a neutral name')
    expect(descriptions.join(' ')).toContain('Name required')
  })
})

function DialogExample({ defaultOpen = false, onOpenChange = vi.fn() }) {
  return (
    <DialogRoot defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DialogTrigger>Open details</DialogTrigger>
      <DialogContent title="Details"><ActionButton>Confirm</ActionButton></DialogContent>
    </DialogRoot>
  )
}

describe('Dialog interaction', () => {
  it('requests opening when its trigger is activated', async () => {
    const onOpenChange = vi.fn()
    await render(<DialogExample onOpenChange={onOpenChange} />)

    await click(element('button'))

    expect(onOpenChange).toHaveBeenCalledOnce()
    expect(element('[role="dialog"]').textContent).toContain('Details')
  })

  it('gives the open dialog its visible title as accessible name', async () => {
    await render(<DialogExample defaultOpen />)
    const dialog = element('[role="dialog"]')
    const titleId = dialog.getAttribute('aria-labelledby') ?? ''

    expect(document.getElementById(titleId)?.textContent).toBe('Details')
  })

  it('moves focus inside an opened dialog', async () => {
    await render(<DialogExample defaultOpen />)
    const dialog = element('[role="dialog"]')

    await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('closes on Escape and restores focus to its trigger', async () => {
    const onOpenChange = vi.fn()
    await render(<DialogExample onOpenChange={onOpenChange} />)
    const trigger = element<HTMLButtonElement>('button')
    trigger.focus()
    await click(trigger)
    onOpenChange.mockClear()
    const dialog = element('[role="dialog"]')

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onOpenChange).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('closes through the accessible close button', async () => {
    const onOpenChange = vi.fn()
    await render(<DialogExample defaultOpen onOpenChange={onOpenChange} />)

    await click(element('button[aria-label="닫기"]'))

    expect(onOpenChange).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })
})
