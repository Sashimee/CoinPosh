import { Color, DirectionalLight, Group, SpotLight, type Vector3 } from 'three/webgpu';
import { rivieraTones } from './palette.ts';

export interface RivieraLighting {
  readonly group: Group;
  readonly key: SpotLight;
  readonly rimWarm: DirectionalLight;
  readonly rimCool: DirectionalLight;
  readonly fill: DirectionalLight;
  dispose(): void;
}

export interface LightingOptions {
  /** Direction towards the sun; the warm rim light comes from it. */
  readonly sunDirection: Vector3;
  readonly shadows: boolean;
}

/**
 * Key: a soft cabin downlight above the player's shoulder that pools on the playfield and
 * casts the only shadow. Rims: the low sunset behind the table (warm, from the sun's bearing
 * but lifted so it grazes the trims) and a cool sea-glass kicker from the opposite quarter.
 * Fill: a weak warm wash from behind the camera so the sun-backlit bulwark reads as ivory
 * gelcoat rather than a grey silhouette.
 */
export function createRivieraLighting(options: LightingOptions): RivieraLighting {
  const group = new Group();
  group.name = 'riviera-lighting';

  const key = new SpotLight(new Color(rivieraTones.keyLight), 16, 6, Math.PI / 5.2, 0.85, 1.6);
  key.position.set(0.55, 1.85, 1.15);
  key.target.position.set(0, 0, -0.1);
  key.castShadow = options.shadows;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 4;
  key.shadow.camera.near = 0.8;
  key.shadow.camera.far = 4;

  const sun = options.sunDirection.clone().normalize();
  const rimWarm = new DirectionalLight(new Color(rivieraTones.rimWarm), 3.2);
  rimWarm.position.set(sun.x * 4, 1.6, sun.z * 4);
  rimWarm.target.position.set(0, 0, 0);

  const rimCool = new DirectionalLight(new Color(rivieraTones.rimCool), 0.9);
  rimCool.position.set(-sun.x * 4 + 1.5, 1.2, sun.z * 3);
  rimCool.target.position.set(0, 0, 0);

  const fill = new DirectionalLight(new Color(rivieraTones.rimWarm), 2.6);
  fill.position.set(0.9, 0.7, 3);
  fill.target.position.set(0, 0, -0.2);

  group.add(key, key.target, rimWarm, rimWarm.target, rimCool, rimCool.target, fill, fill.target);

  return {
    group,
    key,
    rimWarm,
    rimCool,
    fill,
    dispose() {
      key.dispose();
      rimWarm.dispose();
      rimCool.dispose();
      fill.dispose();
    },
  };
}
