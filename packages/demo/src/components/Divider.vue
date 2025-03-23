<script setup lang="ts">
import { ref } from 'vue'
import { useEventListener } from '@vueuse/core'

const props = defineProps<{
  el: HTMLElement | null
  adjustDir: 1 | - 1
}>()

interface Pos {
  x: number
  y: number
}

const getMousePos = (ev: MouseEvent | TouchEvent): Pos => {
  const { clientX: x, clientY: y } =  ev instanceof MouseEvent ? ev : ev.touches[0]
  return { x, y }
}

const dividerEl = ref<HTMLElement | null>(null)
const pos0 = ref<Pos | null>(null)

const onMoveStart = (ev: MouseEvent | TouchEvent) => {
  pos0.value = getMousePos(ev)
  document.body.style.cursor = 'ew-resize'
}

const onMove = (ev: MouseEvent | TouchEvent) => {
  const { el, adjustDir } = props
  if (! pos0.value || ! el) return
  const pos1 = getMousePos(ev)
  const dx = pos1.x - pos0.value.x
  pos0.value = pos1
  el.style.width = `${el.clientWidth + dx * adjustDir}px`
}

const onMoveEnd = (ev: MouseEvent | TouchEvent) => {
  onMove(ev)
  pos0.value = null
  document.body.style.cursor = ''
}

useEventListener(dividerEl, [ 'mousedown', 'touchstart' ], onMoveStart)
useEventListener([ 'mousemove', 'touchmove' ], onMove)
useEventListener([ 'mouseup', 'touchend', 'touchcancel' ], onMoveEnd)
</script>

<template>
  <div ref="dividerEl" class="divider" :class="{ moving: !! pos0 }">
    <div class="divider-inner"></div>
  </div>
</template>

<style scoped>
.divider {
  height: 100%;
  padding: 0 3px;
  flex-grow: 0;
  cursor: pointer;
}
.divider.moving {
  cursor: ew-resize;
  padding: 0 2px;
}

.divider-inner {
  height: 100%;
  width: 1px;
  background-color: #7c8c8d;
  transition: background-color .3s;
}
.divider.moving > .divider-inner {
  background-color: #007acc;
  width: 3px;
}
</style>