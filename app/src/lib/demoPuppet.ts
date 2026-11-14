// Renderer interface for the avatar window, plus the built-in vector demo figure (Phase 0 rig).
import type { Pose } from './rigRender'

export interface Puppet {
  /** Draws one frame of the pose (from poseGen.ts); `t` in ms for idle detail, 0 with reduced motion. */
  frame(pose: Pose, t: number): void
  /** Releases observers; the next puppet replaces the DOM. */
  destroy?(): void
}

const SVG = `<svg viewBox="0 0 200 260" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
  <g data-body>
    <path data-arm="l" d="M62 178 Q40 200 34 232" stroke="#3b6fb6" stroke-width="14" stroke-linecap="round" fill="none"/>
    <path data-arm="r" d="M138 178 Q160 200 166 232" stroke="#3b6fb6" stroke-width="14" stroke-linecap="round" fill="none"/>
    <path d="M56 260 Q56 168 100 166 Q144 168 144 260 Z" fill="#4a86d4"/>
    <g data-head>
      <ellipse cx="100" cy="98" rx="58" ry="64" fill="#f2c9a0"/>
      <path d="M44 86 Q48 30 100 30 Q152 30 156 86 Q132 56 100 58 Q68 56 44 86 Z" fill="#5a3b2a"/>
      <ellipse cx="78" cy="96" rx="8" ry="10" fill="#222"/>
      <ellipse cx="122" cy="96" rx="8" ry="10" fill="#222"/>
      <rect data-lid="up" x="68" y="84" width="20" height="0" fill="#f2c9a0"/>
      <rect data-lid="up" x="112" y="84" width="20" height="0" fill="#f2c9a0"/>
      <rect data-lid="lo" x="68" y="108" width="20" height="0" fill="#f2c9a0"/>
      <rect data-lid="lo" x="112" y="108" width="20" height="0" fill="#f2c9a0"/>
      <ellipse data-mouth cx="100" cy="132" rx="16" ry="2" fill="#7a2630"/>
    </g>
  </g>
</svg>`

export class DemoPuppet implements Puppet {
  private body: SVGGElement
  private head: SVGGElement
  private mouthEl: SVGEllipseElement
  private lidsUp: SVGRectElement[]
  private lidsLo: SVGRectElement[]
  private arms: SVGPathElement[]

  constructor(host: HTMLElement) {
    host.innerHTML = SVG
    const q = <T extends Element>(s: string) => host.querySelector(s) as T
    this.body = q('[data-body]')
    this.head = q('[data-head]')
    this.mouthEl = q('[data-mouth]')
    this.lidsUp = [...host.querySelectorAll<SVGRectElement>('[data-lid="up"]')]
    this.lidsLo = [...host.querySelectorAll<SVGRectElement>('[data-lid="lo"]')]
    this.arms = [q('[data-arm="l"]'), q('[data-arm="r"]')]
  }

  frame(pose: Pose, t: number) {
    const mouth = Math.min(1, Math.max(0, pose.mouth))
    const wide = Math.min(1, Math.max(-1, pose.wide || 0))
    this.mouthEl.setAttribute('ry', String((2 + mouth * 14) * (1 - 0.3 * Math.max(0, wide))))
    this.mouthEl.setAttribute('rx', String((16 - mouth * 4) * (1 + 0.25 * wide)))
    // Lids span y 84..108 (24): the upper one covers 2/3 of it, the lower one 1/3 (LID_MEET in rigRender).
    const blink = Math.min(1, Math.max(0, pose.blink))
    for (const l of this.lidsUp) l.setAttribute('height', String(blink * 16))
    for (const l of this.lidsLo) {
      l.setAttribute('y', String(108 - blink * 8))
      l.setAttribute('height', String(blink * 8))
    }
    this.body.setAttribute('transform', `rotate(${pose.sway * 1.25} 100 260)`)
    this.head.setAttribute('transform', `rotate(${t ? Math.sin((t / 1000) * 1.3) * 3 + mouth * 2 : 0} 100 160)`)
    // The figure faces us: its right arm is on the left of the image.
    this.arms[0].setAttribute('transform', `rotate(${pose.armR} 62 178)`)
    this.arms[1].setAttribute('transform', `rotate(${pose.armL} 138 178)`)
  }
}
