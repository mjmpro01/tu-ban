import type { AgentInfo, CharacterId } from "@tu-ban/shared";
import Phaser from "phaser";
import charMeta from "../../../../assets/game/characters/characters.json";
import emoteMeta from "../../../../assets/game/ui/emotes.json";
import { store } from "../store";
import { AgentSprite } from "./AgentSprite";
import { DESKS, MAP_H, MAP_W, MEETING_SPOTS, PROPS, T, floorLayer, seatPixel, walkGrid, wallLayer } from "./officeMap";

const CHARACTERS: CharacterId[] = ["manager", "researcher", "writer", "cursor", "copilot"];
export const ZOOM = 3;

export class OfficeScene extends Phaser.Scene {
  private agents = new Map<string, AgentSprite>();
  private desks: Phaser.GameObjects.Image[] = [];
  private grid: boolean[][] = [];
  private unsubs: (() => void)[] = [];

  constructor() {
    super("office");
  }

  preload() {
    this.load.image("tiles_floor", "/tiles/tiles_floor.png");
    this.load.image("tiles_wall", "/tiles/tiles_wall.png");
    this.load.atlas("objects", "/objects/objects.png", "/objects/objects.json");
    for (const c of CHARACTERS) this.load.spritesheet(`char_${c}`, `/characters/char_${c}.png`, { frameWidth: 32, frameHeight: 32 });
    this.load.spritesheet("emotes", "/ui/emotes.png", { frameWidth: 16, frameHeight: 16 });
    this.load.spritesheet("bubbles", "/ui/bubbles.png", { frameWidth: 24, frameHeight: 24 });
    this.load.spritesheet("bubble_tails", "/ui/bubble_tails.png", { frameWidth: 8, frameHeight: 8 });
  }

  create() {
    this.cameras.main.setZoom(ZOOM).centerOn((MAP_W * T) / 2, (MAP_H * T) / 2);
    this.cameras.main.setBackgroundColor("#2b1a12");
    this.createAnimations();
    this.buildMap();

    this.grid = walkGrid((frame) => {
      const f = this.textures.getFrame("objects", frame);
      return { w: f.width, h: f.height };
    });

    const sync = () => {
      const s = store.get();
      for (const a of Object.values(s.agents)) this.syncAgent(a);
      for (const [id, sprite] of this.agents) sprite.setSelected(id === s.selectedAgentId);
    };
    this.unsubs.push(store.subscribe(sync));
    this.unsubs.push(
      store.onEvent((e) => {
        if (e.type === "handoff" && e.targetAgentId) {
          const target = store.get().agents[e.targetAgentId];
          if (target) this.agents.get(e.agentId)?.visit(target.desk, e.summary);
        } else if (e.type === "meeting" && e.participants) {
          e.participants.forEach((id, i) => {
            const spot = MEETING_SPOTS[i % MEETING_SPOTS.length];
            this.agents.get(id)?.meet(spot, i === 0 ? "Họp tổng hợp!" : undefined);
          });
        }
      }),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsubs.forEach((u) => u()));
    sync();
    (window as unknown as { __office?: OfficeScene }).__office = this;
  }

  update() {
    for (const a of this.agents.values()) a.tick();
  }

  /** Debug helper: positions and current animation of every agent (window.__office.debug()). */
  debug() {
    return [...this.agents.entries()].map(([id, a]) => ({
      id,
      x: Math.round(a.sprite.x),
      y: Math.round(a.sprite.y),
      anim: a.sprite.anims.currentAnim?.key,
      visible: a.sprite.visible,
    }));
  }

  private createAnimations() {
    const anims = charMeta.animations as Record<string, { frames: number[]; frameRate: number; repeat: number }>;
    for (const c of CHARACTERS)
      for (const [name, a] of Object.entries(anims))
        this.anims.create({
          key: `${c}:${name}`,
          frames: a.frames.map((frame) => ({ key: `char_${c}`, frame })),
          frameRate: a.frameRate,
          repeat: a.repeat,
        });
    for (const [name, a] of Object.entries(emoteMeta.animations as Record<string, { frames: number[]; frameRate: number }>))
      this.anims.create({ key: `emote:${name}`, frames: a.frames.map((frame) => ({ key: "emotes", frame })), frameRate: a.frameRate, repeat: -1 });
  }

  private buildMap() {
    const floor = this.make.tilemap({ data: floorLayer(), tileWidth: T, tileHeight: T });
    floor.createLayer(0, floor.addTilesetImage("tiles_floor")!, 0, 0)!.setDepth(-20);
    const walls = this.make.tilemap({ data: wallLayer(), tileWidth: T, tileHeight: T });
    walls.createLayer(0, walls.addTilesetImage("tiles_wall")!, 0, 0)!.setDepth(-10);

    for (const p of PROPS) {
      const img = this.add.image(p.x, p.y, "objects", p.frame).setOrigin(0, 1);
      img.setDepth(p.solid ? p.y : -5);
    }
    DESKS.forEach((d, i) => {
      this.desks[i] = this.add.image(d.tx * T, d.ty * T, "objects", "desk_off").setOrigin(0, 1).setDepth(d.ty * T);
      const seat = seatPixel(i);
      // the chair back is drawn over the seated agent
      this.add.image(d.tx * T + 10, d.ty * T + 17, "objects", "chair_back").setOrigin(0, 1).setDepth(seat.y + 6);
    });
  }

  private syncAgent(a: AgentInfo) {
    let sprite = this.agents.get(a.id);
    if (!sprite) {
      sprite = new AgentSprite(this, a, this.grid, (id) => store.select(id));
      this.agents.set(a.id, sprite);
    } else {
      sprite.update(a);
    }
    const desk = this.desks[a.desk];
    if (desk) {
      const working = a.status === "working" || a.status === "waiting_approval";
      const frame = !working ? "desk_off" : a.provider === "claude" ? "desk_on_orange" : "desk_on_blue";
      if (desk.frame.name !== frame) desk.setFrame(frame);
    }
  }
}

export function createGame(parent: HTMLElement) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: MAP_W * T * ZOOM,
    height: MAP_H * T * ZOOM,
    pixelArt: true,
    backgroundColor: "#2b1a12",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [OfficeScene],
  });
}
