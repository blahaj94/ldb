// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import App from './App'

it('preserves one counter increment for each activation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => root.render(<App />))
    const button = container.querySelector('button')
    const isButtonMissing = button == null
    if (isButtonMissing) throw new Error('Counter button did not render')
    expect(button.textContent).toBe('Count is 0')

    await act(async () => button.click())
    expect(button.textContent).toBe('Count is 1')
    await act(async () => button.click())
    expect(button.textContent).toBe('Count is 2')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
