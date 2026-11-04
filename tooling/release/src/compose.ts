import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PACKAGES, SERVICES, type Service } from './manifest.js';
import { activeDirectory, installedPackage, readProject, type Project } from './project.js';
import { atomic, json, run, writeJson } from './files.js';
import { manager, serviceReady, upgrade, type Manager } from './engine.js';
import { coordinatorRequest } from './coordinator.js';

interface Image {
  id: string;
  reference: string;
  version: string;
}
interface ComposeState {
  schema: 1;
  installation: string;
  images: Partial<Record<Service, Image>>;
  rendered: Record<string, unknown>;
  source?: { compose: string; environment?: string; channel?: string };
}
interface Inspect {
  Id: string;
  Image: string;
  RepoDigests?: string[];
  Config: { Hostname?: string; Labels: Record<string, string> };
}
const admissionSchema = z
  .object({
    service: z.enum(SERVICES),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    container: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,100}$/),
  })
  .strict();
function composeName(project: Project): string {
  return `hive-${project.id.slice(0, 8)}`;
}
function composeArgs(root: string): string[] {
  return ['compose', '--project-directory', root, '-f', join(root, 'compose.yaml')];
}

/** Managed Compose deliberately reuses the stores already configured by init.
 * Linux host networking keeps those loopback-only stores and TLS names unchanged. */
export function configureCompose(root: string): void {
  if (process.platform !== 'linux')
    throw new Error('Managed Compose recovery currently requires a Linux host');
  const project = readProject(root);
  const services: Record<string, unknown> = {};
  const version = installedPackage(activeDirectory(root), '@hivemagnus/hive').version;
  for (const service of project.services) {
    const name = PACKAGES[service].split('/')[1]!;
    services[service] = {
      container_name: `${composeName(project)}-${service}-1`,
      image: `ghcr.io/cheftaco/${name}:\${HIVE_IMAGE_TAG:-${version}}`,
      network_mode: 'host',
      user: `${process.getuid!()}:${process.getgid!()}`,
      env_file: [join(root, 'config', `${service}.env`), join(root, 'config/upgrade.env')],
      environment: {
        HIVE_HOME: root,
        HIVE_MANAGED_PROJECT: root,
        HIVE_COMPOSE_UPGRADE_SUPERVISOR: '${HIVE_COMPOSE_UPGRADE_SUPERVISOR:-true}',
        HIVE_COORDINATOR_SOCKET: join(root, 'run/coordinator.sock'),
        NODE_EXTRA_CA_CERTS: join(root, 'tls/ca.crt'),
      },
      volumes: [
        `${join(root, service)}:${join(root, service)}`,
        `${join(root, 'tls')}:${join(root, 'tls')}:ro`,
        `${join(root, 'config/project.json')}:${join(root, 'config/project.json')}:ro`,
        `${join(root, 'run')}:${join(root, 'run')}:ro`,
      ],
      restart: 'unless-stopped',
      stop_grace_period: '150s',
    };
  }
  writeJson(join(root, 'compose.yaml'), { name: composeName(project), services });
  atomic(
    join(root, '.env'),
    `# Exact by default. Set the same-major tag explicitly to follow releases.\nHIVE_IMAGE_TAG=${version}\n`,
  );
}

export class ComposeController {
  private state: ComposeState | undefined;
  private permits = new Map<Service, string>();
  private proposal: Promise<unknown> | undefined;
  private result: unknown = { state: 'idle' };
  private project: Project;
  constructor(private root: string) {
    this.project = readProject(root);
    const file = join(root, 'run/compose-state.json');
    if (existsSync(file)) {
      this.state = json<ComposeState>(file);
      if (this.state.installation !== this.project.id)
        throw new Error('Compose image state belongs to another installation');
    }
    if (existsSync(join(root, 'run/compose-result.json')))
      this.result = json(join(root, 'run/compose-result.json'));
  }
  status(): unknown {
    return this.result;
  }
  busy(): boolean {
    return Boolean(this.proposal);
  }
  private saveState(state: ComposeState): void {
    this.state = state;
    writeJson(join(this.root, 'run/compose-state.json'), state);
    const version = Object.values(state.images)[0]!.version;
    writeJson(join(this.root, 'run/compose-history', `${version}.json`), state);
  }
  private async inspect(reference: string, image = false): Promise<Inspect> {
    return JSON.parse(
      await run('docker', [image ? 'image' : 'container', 'inspect', reference]),
    )[0] as Inspect;
  }
  private async rendered(): Promise<Record<string, unknown>> {
    return JSON.parse(
      await run('docker', [...composeArgs(this.root), 'config', '--format', 'json']),
    ) as Record<string, unknown>;
  }
  private source(): NonNullable<ComposeState['source']> {
    const environment = join(this.root, '.env');
    return {
      compose: readFileSync(join(this.root, 'compose.yaml'), 'utf8'),
      ...(existsSync(environment) ? { environment: readFileSync(environment, 'utf8') } : {}),
    };
  }
  private async commitSource(state: ComposeState): Promise<void> {
    if (!state.source) return;
    if (state.source.channel && /^\d+(\.\d+)?$/.test(state.source.channel)) {
      for (const service of this.project.services) {
        const name = PACKAGES[service].split('/')[1]!;
        await run('docker', [
          'tag',
          state.images[service]!.id,
          `ghcr.io/cheftaco/${name}:${state.source.channel}`,
        ]);
      }
    }
    atomic(join(this.root, 'compose.yaml'), state.source.compose);
    if (state.source.environment !== undefined)
      atomic(join(this.root, '.env'), state.source.environment);
    if (process.env.HIVE_IMAGE_TAG && state.source.channel)
      process.env.HIVE_IMAGE_TAG = state.source.channel;
  }
  private async prepareTarget(version: string): Promise<ComposeState> {
    const rendered = structuredClone(await this.rendered());
    const definitions = rendered.services as Record<string, { image: string; platform?: string }>;
    const source = this.source();
    let original: { services: Record<string, { image: string }> };
    try {
      original = JSON.parse(source.compose);
    } catch {
      throw new Error(
        'Managed CLI image upgrades require the generated Compose project; retain the existing operator procedure for custom YAML',
      );
    }
    const images: Partial<Record<Service, Image>> = {};
    const shortTag = definitions[this.project.services[0]!]!.image.split(':').at(-1)!;
    const channel = /^\d+$/.test(shortTag)
      ? version.split('.')[0]!
      : /^\d+\.\d+$/.test(shortTag)
        ? version.split('.').slice(0, 2).join('.')
        : version;
    let templated = false;
    for (const service of this.project.services) {
      const name = PACKAGES[service].split('/')[1]!;
      const selected = definitions[service]!;
      const local =
        process.env.HIVE_INSTALL_FROM && /^(127\.0\.0\.1:\d+)\//.exec(selected.image)?.[1];
      const reference = `${local || 'ghcr.io/cheftaco'}/${name}:${version}`;
      await run(
        'docker',
        ['pull', ...(selected.platform ? ['--platform', selected.platform] : []), reference],
        { timeout: 900_000 },
      );
      const image = await this.inspect(reference, true);
      if (
        image.Config.Labels['org.opencontainers.image.version'] !== version ||
        image.Config.Labels['io.hivemagnus.package'] !== PACKAGES[service]
      )
        throw new Error('Target image is outside the selected release bundle');
      images[service] = {
        id: image.Id,
        reference: image.RepoDigests?.find((r) => r.startsWith('ghcr.io/cheftaco/')) || image.Id,
        version,
      };
      selected.image = reference;
      if (original.services[service]?.image.includes('${HIVE_IMAGE_TAG')) templated = true;
      else original.services[service]!.image = reference;
    }
    source.compose = `${JSON.stringify(original, null, 2)}\n`;
    if (templated) {
      const environment = source.environment || '';
      source.environment = /^HIVE_IMAGE_TAG=.*$/m.test(environment)
        ? environment.replace(/^HIVE_IMAGE_TAG=.*$/m, `HIVE_IMAGE_TAG=${channel}`)
        : `${environment}\nHIVE_IMAGE_TAG=${channel}\n`;
      source.channel = channel;
    }
    return { schema: 1, installation: this.project.id, images, rendered, source };
  }
  private async proposed(version: string): Promise<ComposeState> {
    const rendered = await this.rendered();
    const definitions = rendered.services as Record<string, { image: string }>;
    const images: Partial<Record<Service, Image>> = {};
    for (const service of this.project.services) {
      const reference = definitions[service]?.image;
      if (!reference) throw new Error('Compose definition omits an enrolled service');
      const image = await this.inspect(reference, true);
      if (
        image.Config.Labels['org.opencontainers.image.version'] !== version ||
        image.Config.Labels['io.hivemagnus.package'] !== PACKAGES[service]
      )
        throw new Error(
          'Mixed or incomplete Compose release; pull every enrolled image before upgrading',
        );
      images[service] = {
        id: image.Id,
        reference: image.RepoDigests?.find((r) => r.startsWith('ghcr.io/cheftaco/')) || image.Id,
        version,
      };
    }
    const source = this.source();
    const tag = definitions[this.project.services[0]!]!.image.split(':').at(-1)!;
    if (source.compose.includes('${HIVE_IMAGE_TAG')) source.channel = tag;
    return { schema: 1, installation: this.project.id, images, rendered, source };
  }
  async admit(input: unknown): Promise<{ admitted: boolean; error?: string }> {
    if (process.env.HIVE_COMPOSE_UPGRADE_SUPERVISOR !== 'true')
      throw new Error('Compose supervision is disabled');
    const body = admissionSchema.parse(input);
    if (!this.project.services.includes(body.service)) throw new Error('Service is not enrolled');
    if (body.container !== `${composeName(this.project)}-${body.service}-1`)
      throw new Error('Container name is outside the enrolled project');
    const container = await this.inspect(body.container);
    const labels = container.Config.Labels;
    if (
      labels['com.docker.compose.project'] !== composeName(this.project) ||
      labels['com.docker.compose.service'] !== body.service ||
      labels['org.opencontainers.image.version'] !== body.version ||
      labels['io.hivemagnus.package'] !== PACKAGES[body.service]
    )
      throw new Error('Container identity does not match the enrolled Compose service');
    const predecessor = this.project.services[this.project.services.indexOf(body.service) - 1];
    const ordered = async () =>
      !predecessor || (await serviceReady(this.root, predecessor, body.version));
    if (this.permits.get(body.service) === container.Image) return { admitted: await ordered() };
    if (
      this.state?.images[body.service]?.id === container.Image &&
      !existsSync(join(this.root, 'run/maintenance.json'))
    )
      return { admitted: await ordered() };
    const current = installedPackage(activeDirectory(this.root), '@hivemagnus/hive').version;
    if (!this.state && body.version === current) {
      this.saveState(await this.proposed(current));
      return {
        admitted: this.state!.images[body.service]?.id === container.Image && (await ordered()),
      };
    }
    if (!this.state) throw new Error('Initial Compose image set has not been approved');
    if (!this.proposal) {
      const old = this.state;
      this.result = { state: 'preparing', version: body.version };
      this.proposal = (async () => {
        try {
          const proposed = await this.proposed(body.version);
          this.result = { state: 'upgrading', version: body.version };
          const from = process.env.HIVE_INSTALL_FROM;
          const txn = await upgrade(
            this.root,
            { to: body.version, ...(from ? { from } : {}) },
            this.adapter(true, proposed),
          );
          this.saveState(proposed);
          this.result = { state: 'completed', version: body.version, transaction: txn };
        } catch (error) {
          this.result = {
            state: 'failed',
            version: body.version,
            error: error instanceof Error ? error.message : 'Compose upgrade failed',
          };
          // A proposal can fail before the npm transaction starts (for example mixed tags).
          // Recreate the previous immutable images; preserve all current data.
          if (!existsSync(join(this.root, 'run/maintenance.json'))) {
            try {
              await this.restoreImages(old);
            } catch {
              writeJson(join(this.root, 'run/maintenance.json'), {
                reason: 'Compose recovery failed; review the recovery receipt before restarting',
              });
            }
          }
        } finally {
          writeJson(join(this.root, 'run/compose-result.json'), this.result);
          this.proposal = undefined;
        }
      })();
    }
    return { admitted: false };
  }
  private async restoreImages(state: ComposeState): Promise<void> {
    this.permits.clear();
    for (const service of this.project.services)
      this.permits.set(service, state.images[service]!.id);
    const rendered = structuredClone(state.rendered);
    const services = rendered.services as Record<string, Record<string, unknown>>;
    for (const service of this.project.services) {
      services[service]!.image = state.images[service]!.reference;
      services[service]!.pull_policy = 'never';
    }
    const file = join(this.root, 'run/compose-recovery.json');
    writeJson(file, rendered);
    await run(
      'docker',
      [
        'compose',
        '--project-directory',
        this.root,
        '-f',
        file,
        'up',
        '-d',
        '--force-recreate',
        '--pull',
        'never',
      ],
      { timeout: 300_000 },
    );
    await this.commitSource(state);
  }
  adapter(external = false, proposed?: ComposeState): Manager {
    const health = manager(this.root, { ...this.project, manager: 'foreground' }).health;
    const old = this.state;
    let released = false;
    let selected = proposed;
    return {
      prepare: async (version) => {
        if (!external) selected = await this.prepareTarget(version);
        else if (
          !selected ||
          !Object.values(selected.images).every((image) => image?.version === version)
        )
          throw new Error('Pulled image set differs from the selected npm release bundle');
      },
      stop: async () => {
        this.permits.clear();
        const ids = (
          await run('docker', [
            'ps',
            '-q',
            '--filter',
            `label=com.docker.compose.project=${composeName(this.project)}`,
          ])
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const containers = await Promise.all(
          ids.map(async (id) => ({ id, container: await this.inspect(id) })),
        );
        containers.sort(
          (a, b) =>
            this.project.services.indexOf(
              b.container.Config.Labels['com.docker.compose.service'] as Service,
            ) -
            this.project.services.indexOf(
              a.container.Config.Labels['com.docker.compose.service'] as Service,
            ),
        );
        for (const { id, container } of containers) {
          const service = container.Config.Labels['com.docker.compose.service'] as Service;
          // Proposed entrypoints are waiting at the gate and have opened no stores.
          if (external && !released && selected?.images[service]?.id === container.Image) continue;
          await run('docker', ['stop', '--time', '150', id], { timeout: 180_000 });
        }
      },
      start: async () => {
        const active = installedPackage(activeDirectory(this.root), '@hivemagnus/hive').version;
        const history = join(this.root, 'run/compose-history', `${active}.json`);
        if (old && Object.values(old.images).every((image) => image?.version === active)) {
          released = true;
          await this.restoreImages(old);
          this.saveState(old);
          return;
        }
        if (existsSync(history)) {
          const previous = json<ComposeState>(history);
          if (previous.installation !== this.project.id)
            throw new Error('Image history belongs to another installation');
          released = true;
          await this.restoreImages(previous);
          this.saveState(previous);
          return;
        }
        const target = selected || (await this.proposed(active));
        this.permits.clear();
        for (const service of this.project.services)
          this.permits.set(service, target.images[service]!.id);
        released = true;
        if (!external) {
          const file = join(this.root, 'run/compose-candidate.json');
          writeJson(file, target.rendered);
          await run(
            'docker',
            [
              'compose',
              '--project-directory',
              this.root,
              '-f',
              file,
              'up',
              '-d',
              '--pull',
              'never',
            ],
            {
              timeout: 300_000,
            },
          );
        }
      },
      health: async (directory) => {
        await health(directory);
        const version = installedPackage(directory, '@hivemagnus/hive').version;
        if (
          this.state &&
          Object.values(this.state.images).every((image) => image?.version === version)
        )
          return;
        const accepted =
          selected && Object.values(selected.images).every((image) => image?.version === version)
            ? selected
            : await this.proposed(version);
        if (!external) await this.commitSource(accepted);
        this.saveState(accepted);
      },
    };
  }
}

export async function composeAdmission(service: Service, version: string): Promise<void> {
  if (process.env.HIVE_COMPOSE_UPGRADE_SUPERVISOR !== 'true') return;
  const root = process.env.HIVE_HOME;
  if (!root) throw new Error('HIVE_HOME is required for managed image admission');
  const container = `${composeName(readProject(root))}-${service}-1`;
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    try {
      const response = (await coordinatorRequest(root, 'admit', {
        service,
        version,
        container,
      })) as { admitted: boolean };
      if (response.admitted) return;
    } catch {
      /* Supervisor absence always leaves the entrypoint gated. */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Compose supervisor did not admit this image; no datastore was opened');
}
