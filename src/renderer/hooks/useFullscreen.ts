import { useCallback, useEffect, useRef, useState } from 'react'

// 全屏切换 hook：托管目标元素的 requestFullscreen / exitFullscreen，
// 并以 fullscreenchange 事件为唯一状态来源（含 webkit 前缀回退）。
// onChange 可用于全屏状态变化后重新 resize 图表等副作用。
export function useFullscreen<T extends HTMLElement = HTMLDivElement>(
  onChange?: (fullscreen: boolean) => void,
) {
  const ref = useRef<T>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const toggle = useCallback(() => {
    const el = ref.current
    if (!el) {
      return
    }

    if (!document.fullscreenElement) {
      const request = el.requestFullscreen || (el as any).webkitRequestFullscreen
      request?.call(el)
    } else {
      const exit = document.exitFullscreen || (document as any).webkitExitFullscreen
      exit?.call(document)
    }
  }, [])

  useEffect(() => {
    const handleChange = () => {
      const active = !!document.fullscreenElement
      setIsFullscreen(active)
      onChange?.(active)
    }

    document.addEventListener('fullscreenchange', handleChange)
    document.addEventListener('webkitfullscreenchange', handleChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleChange)
      document.removeEventListener('webkitfullscreenchange', handleChange)
    }
  }, [onChange])

  return { ref, isFullscreen, toggle }
}
