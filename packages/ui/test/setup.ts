// jsdom에는 layout 관측이 없다. Scale feedback의 크기 관측만 격리하며
// click·입력·Dialog/focus 구현은 실제 SEED runtime으로 실행한다.
class LayoutObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, { ResizeObserver: LayoutObserver })
