import type { AgentInfo } from "@tu-ban/shared";
import Phaser from "phaser";
import { type PoiName, POIS, T, deskVisitor, findPath, seatApproach, seatPixel } from "./officeMap";

type Face = "up" | "down" | "left" | "right";
type Pose = "type" | "think" | "doze" | "stand" | "ask";
type BubbleStyle = 0 | 1 | 2 | 3; // speech, thought, alert, error (frame order in bubbles.png)

interface Place {
  kind: "seat" | "deskfront" | "poi" | "visit";
  poi?: PoiName;
  desk?: number;
}

interface Behaviour {
  place: Place;
  pose: Pose;
  face?: Face;
  emote?: string;
  bubble?: { text: string; style: BubbleStyle; sticky?: boolean };
}

const WALK_SPEED = 48; // px per second
const PLACE_DWELL_MS = 5000; // minimum time at a place before walking somewhere else
const IDLE_SPOTS: PoiName[] = ["coffee", "water", "sofa", "bookshelf"];
const FONT = "'Segoe UI', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif";

export class AgentSprite {
  readonly sprite: Phaser.GameObjects.Sprite;
  private emote: Phaser.GameObjects.Sprite;
  private bubble: Phaser.GameObjects.Container;
  private bubbleBg: Phaser.GameObjects.NineSlice;
  private bubbleTail: Phaser.GameObjects.Image;
  private bubbleText: Phaser.GameObjects.Text;
  private label: Phaser.GameObjects.Text;
  private marker: Phaser.GameObjects.Ellipse;

  private agent: AgentInfo;
  private walkToken = 0;
  private walking = false;
  private placeKey = "";
  private lastChange = 0;
  private pendingTimer?: Phaser.Time.TimerEvent;
  private override?: Behaviour;
  private idleSpot: PoiName | "desk" = "desk";
  private idleTimer?: Phaser.Time.TimerEvent;
  private bubbleTimer?: Phaser.Time.TimerEvent;
  private shownBubble = "";
  private selected = false;

  constructor(
    private scene: Phaser.Scene,
    agent: AgentInfo,
    private grid: boolean[][],
    onClick: (id: string) => void,
  ) {
    this.agent = agent;
    const start = seatPixel(agent.desk);
    this.marker = scene.add.ellipse(start.x, start.y, 14, 5, 0xfff1a8, 0.9).setVisible(false);
    this.sprite = scene.add.sprite(start.x, start.y, `char_${agent.character}`, 0).setOrigin(0.5, 1);
    this.sprite.setInteractive({ pixelPerfect: true, useHandCursor: true }).on("pointerdown", () => onClick(agent.id));
    this.emote = scene.add.sprite(0, 0, "emotes", 0).setOrigin(0.5, 1).setVisible(false);

    this.bubbleBg = scene.add.nineslice(0, 0, "bubbles", 0, 40, 16, 8, 8, 8, 8).setOrigin(0.5, 1);
    this.bubbleTail = scene.add.image(0, -1, "bubble_tails", 0).setOrigin(0.5, 0);
    this.bubbleText = scene.add
      .text(0, 0, "", { fontFamily: FONT, fontSize: "6px", color: "#3b2416", wordWrap: { width: 60 }, align: "center", maxLines: 3 })
      .setResolution(4)
      .setOrigin(0.5, 1);
    this.bubble = scene.add.container(0, 0, [this.bubbleBg, this.bubbleTail, this.bubbleText]).setVisible(false);

    this.label = scene.add
      .text(0, 0, agent.name, {
        fontFamily: FONT,
        fontSize: "6px",
        color: "#fff7e0",
        backgroundColor: "#3b2416cc",
        padding: { x: 2, y: 1 },
      })
      .setResolution(4)
      .setOrigin(0.5, 0)
      .setVisible(false);

    this.sitAt(agent.desk, "doze");
    this.apply(true);
  }

  // ---------------------------------------------------------------- public
  update(agent: AgentInfo) {
    const prev = this.agent;
    this.agent = agent;
    if (prev.status !== agent.status || prev.activity !== agent.activity || prev.summary !== agent.summary) this.apply();
  }

  setSelected(on: boolean) {
    this.selected = on;
    this.marker.setVisible(on);
    this.label.setVisible(on);
  }

  /** Walk to another agent's desk to hand work over, then carry on. */
  visit(desk: number, text: string) {
    this.override = {
      place: { kind: "visit", desk },
      pose: "stand",
      face: "left",
      bubble: { text, style: 0 },
    };
    this.apply(true);
    this.scene.time.delayedCall(9000, () => {
      this.override = undefined;
      this.apply(true);
    });
  }

  /** Called every frame: keep the attached UI on the character and depth-sorted. */
  tick() {
    const { x, y } = this.sprite;
    this.sprite.setDepth(y);
    this.marker.setPosition(x, y).setDepth(y - 1);
    this.emote.setPosition(x + 11, y - 22).setDepth(10000);
    this.bubble.setPosition(x, y - 31).setDepth(10001);
    this.label.setPosition(x, y + 2).setDepth(10002);
  }

  // ---------------------------------------------------------------- behaviour
  private behaviour(): Behaviour {
    if (this.override) return this.override;
    const a = this.agent;
    const seat: Place = { kind: "seat" };
    const text = a.summary;
    if (a.status === "waiting_approval")
      return { place: { kind: "deskfront" }, pose: "ask", emote: "alert", bubble: { text, style: 2, sticky: true } };
    if (a.status === "error")
      return { place: { kind: "deskfront" }, pose: "stand", emote: "angry", bubble: { text, style: 3, sticky: true } };
    switch (a.activity) {
      case "search":
        return { place: { kind: "poi", poi: "bookshelf" }, pose: "stand", face: "up", emote: "search", bubble: { text, style: 0 } };
      case "thinking":
        return { place: seat, pose: "think", emote: "thinking" };
      case "code":
        return { place: seat, pose: "type", emote: "code", bubble: { text, style: 0 } };
      case "write":
        return { place: seat, pose: "type", bubble: { text, style: 0 } };
      case "remote":
        return { place: seat, pose: "type", emote: "remote", bubble: { text, style: 1 } };
      case "handoff":
        return { place: seat, pose: "think", emote: "handoff" };
      case "done":
        return { place: { kind: "deskfront" }, pose: "stand", emote: "celebrate", bubble: { text, style: 0 } };
      case "approval":
        return { place: { kind: "deskfront" }, pose: "ask", emote: "alert", bubble: { text, style: 2, sticky: true } };
      case "error":
        return { place: { kind: "deskfront" }, pose: "stand", emote: "angry", bubble: { text, style: 3, sticky: true } };
      default:
        return this.idleBehaviour();
    }
  }

  private idleBehaviour(): Behaviour {
    if (!this.idleTimer) this.scheduleIdleWander();
    if (this.idleSpot === "desk") return { place: { kind: "seat" }, pose: "doze", emote: "sleep" };
    return { place: { kind: "poi", poi: this.idleSpot }, pose: "stand", face: "up", emote: this.idleSpot === "coffee" ? "coffee" : undefined };
  }

  private scheduleIdleWander() {
    this.idleTimer = this.scene.time.delayedCall(Phaser.Math.Between(9000, 20000), () => {
      this.idleTimer = undefined;
      if (this.agent.status !== "idle" || this.agent.activity !== "idle") return;
      this.idleSpot = Math.random() < 0.45 ? "desk" : Phaser.Utils.Array.GetRandom(IDLE_SPOTS);
      this.apply(true);
    });
  }

  /**
   * Apply the current behaviour. Emote, bubble and pose update at once; moving to another
   * place is rate-limited so quick tool calls don't make agents run back and forth.
   */
  private apply(force = false) {
    if (this.agent.activity !== "idle") {
      this.idleTimer?.remove();
      this.idleTimer = undefined;
      this.idleSpot = "desk";
    }
    const b = this.behaviour();
    this.showEmote(b.emote);
    this.showBubble(b.bubble);
    const key = `${b.place.kind}:${b.place.poi ?? ""}:${b.place.desk ?? ""}`;
    if (key === this.placeKey) {
      this.pendingTimer?.remove();
      this.pendingTimer = undefined;
      if (!this.walking) this.pose(b);
      return;
    }
    const wait = PLACE_DWELL_MS - (this.scene.time.now - this.lastChange);
    if (!force && wait > 0) {
      if (!this.pendingTimer) this.pendingTimer = this.scene.time.delayedCall(wait, () => {
        this.pendingTimer = undefined;
        this.apply(true);
      });
      return;
    }
    this.pendingTimer?.remove();
    this.pendingTimer = undefined;
    this.placeKey = key;
    this.lastChange = this.scene.time.now;
    this.goTo(b);
  }

  // ---------------------------------------------------------------- movement
  private currentTile() {
    return { tx: Math.floor(this.sprite.x / T), ty: Math.floor((this.sprite.y - 1) / T) };
  }

  private goTo(b: Behaviour) {
    const desk = this.agent.desk;
    let tile: { tx: number; ty: number };
    let final: { x: number; y: number } | undefined;
    switch (b.place.kind) {
      case "seat":
        tile = seatApproach(desk);
        final = seatPixel(desk);
        break;
      case "deskfront":
        tile = seatApproach(desk);
        break;
      case "visit":
        tile = deskVisitor(b.place.desk!);
        break;
      default:
        tile = POIS[b.place.poi!];
    }
    const token = ++this.walkToken;
    const path = findPath(this.grid, this.currentTile(), tile) ?? [];
    const points = path.map((p) => ({ x: p.tx * T + T / 2, y: p.ty * T + T - 2 }));
    if (final) points.push(final);
    this.walking = true;
    this.walk(points, token, () => {
      this.walking = false;
      // pose for whatever the agent is doing *now* (it may have changed while walking)
      const now = this.behaviour();
      this.pose(`${now.place.kind}:${now.place.poi ?? ""}:${now.place.desk ?? ""}` === this.placeKey ? now : b);
    });
  }

  private walk(points: { x: number; y: number }[], token: number, done: () => void): void {
    if (token !== this.walkToken) return;
    const next = points.shift();
    if (!next) return done();
    const dx = next.x - this.sprite.x;
    const dy = next.y - this.sprite.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return this.walk(points, token, done);
    const face: Face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    this.play(`walk_${face}`);
    this.scene.tweens.add({
      targets: this.sprite,
      x: next.x,
      y: next.y,
      duration: (dist / WALK_SPEED) * 1000,
      onComplete: () => this.walk(points, token, done),
    });
  }

  private sitAt(desk: number, pose: Pose) {
    const p = seatPixel(desk);
    this.sprite.setPosition(p.x, p.y);
    this.play(pose);
  }

  private pose(b: Behaviour) {
    switch (b.pose) {
      case "type":
      case "think":
      case "doze":
        return this.play(b.pose);
      case "ask":
        return this.play("ask");
      default:
        return this.play(`idle_${b.face ?? "down"}`);
    }
  }

  private play(anim: string) {
    const key = `${this.agent.character}:${anim}`;
    if (this.sprite.anims.currentAnim?.key !== key) this.sprite.play(key);
  }

  // ---------------------------------------------------------------- emote & bubble
  private showEmote(name?: string) {
    if (!name) {
      this.emote.setVisible(false);
      return;
    }
    this.emote.setVisible(true);
    const key = `emote:${name}`;
    if (this.emote.anims.currentAnim?.key !== key) this.emote.play(key);
  }

  private showBubble(b?: Behaviour["bubble"]) {
    if (!b?.text) {
      this.bubble.setVisible(false);
      this.shownBubble = "";
      return;
    }
    const sig = `${b.style}|${b.text}`;
    if (sig === this.shownBubble && this.bubble.visible) return;
    this.shownBubble = sig;
    const text = b.text.length > 48 ? `${b.text.slice(0, 47)}…` : b.text;
    this.bubbleText.setText(text);
    const w = Math.max(24, Math.min(68, Math.ceil(this.bubbleText.width) + 8));
    const h = Math.max(14, Math.ceil(this.bubbleText.height) + 7);
    this.bubbleBg.setFrame(b.style).setSize(w, h);
    this.bubbleTail.setFrame(b.style);
    this.bubbleText.setPosition(0, -4);
    this.bubble.setVisible(true);
    this.bubbleTimer?.remove();
    if (!b.sticky) this.bubbleTimer = this.scene.time.delayedCall(6000, () => this.bubble.setVisible(false));
  }

  destroy() {
    [this.sprite, this.emote, this.bubble, this.label, this.marker].forEach((o) => o.destroy());
  }

  get selectedState() {
    return this.selected;
  }
}
