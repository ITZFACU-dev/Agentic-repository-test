/**
 * Screen-space labels for bodies, Lagrange points and habitable zones.
 *
 * Kept in the DOM rather than drawn as textured quads: text stays crisp at any
 * resolution, it costs nothing on the GPU, and CSS can handle the collision
 * avoidance that makes a 261-body scene readable.
 */

import * as THREE from 'three';

export interface LabelRequest {
  key: string;
  text: string;
  position: THREE.Vector3;
  kind: 'body' | 'lagrange' | 'hazard';
  selected?: boolean;
  /** Body radius, used to decide whether the label is worth drawing. */
  radius?: number;
}

interface LabelEntry {
  element: HTMLDivElement;
  kind: LabelRequest['kind'];
  lastSeen: number;
}

export class Labels {
  private readonly root: HTMLDivElement;
  private entries = new Map<string, LabelEntry>();
  private frame = 0;
  enabled = true;
  maxLabels = 40;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'label-layer';
    container.appendChild(this.root);
  }

  update(requests: LabelRequest[], camera: THREE.Camera, width: number, height: number): void {
    this.frame++;
    if (!this.enabled) {
      for (const e of this.entries.values()) e.element.style.display = 'none';
      return;
    }
    const sorted = requests.slice(0, 200);
    const seen = new Set<string>();
    const projected: { req: LabelRequest; x: number; y: number; depth: number; scale: number }[] = [];
    const v = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);

    for (const req of sorted) {
      v.copy(req.position).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height;
      if (x < -80 || y < -40 || x > width + 80 || y > height + 40) continue;
      const dist = camPos.distanceTo(req.position);
      const angular = ((req.radius ?? 1) / Math.max(dist, 1)) * (height / (2 * Math.tan((camera as THREE.PerspectiveCamera).fov * Math.PI / 360)));
      projected.push({ req, x, y, depth: dist, scale: Math.min(3, Math.max(0.6, angular)) });
    }

    // Closest first, and never more than `maxLabels` on screen at once.
    projected.sort((a, b) => {
      if (a.req.selected) return -1;
      if (b.req.selected) return 1;
      return a.depth - b.depth;
    });
    const kept = projected.slice(0, this.maxLabels);

    for (const item of kept) {
      seen.add(item.req.key);
      let entry = this.entries.get(item.req.key);
      if (!entry) {
        const element = document.createElement('div');
        element.className = `label label-${item.req.kind}`;
        this.root.appendChild(element);
        entry = { element, kind: item.req.kind, lastSeen: this.frame };
        this.entries.set(item.req.key, entry);
      }
      entry.lastSeen = this.frame;
      const el = entry.element;
      if (el.textContent !== item.req.text) el.textContent = item.req.text;
      el.style.display = 'block';
      el.style.transform = `translate(-50%, -50%) translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`;
      el.style.fontSize = `${(11 * item.scale).toFixed(1)}px`;
      el.classList.toggle('selected', item.req.selected === true);
      el.classList.toggle('hazard', item.req.kind === 'hazard');
    }

    // Retire labels that have not been seen for a few frames.
    for (const [key, entry] of this.entries) {
      if (seen.has(key)) continue;
      if (this.frame - entry.lastSeen > 4) {
        entry.element.remove();
        this.entries.delete(key);
      } else {
        entry.element.style.display = 'none';
      }
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }
}
