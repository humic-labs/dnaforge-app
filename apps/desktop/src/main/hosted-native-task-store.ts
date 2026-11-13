interface HostedPlanningTask {
  readonly id: string;
  readonly ownerId: number;
  readonly turnBindingToken: string;
  subject: string;
  description: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  metadata: Record<string, unknown>;
  readonly blocks: Set<string>;
  readonly blockedBy: Set<string>;
}

function requiredString(input: Record<string, unknown>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Native tool input ${key} is invalid.`);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maximum: number
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`Native tool input ${key} is invalid.`);
  }
  return value;
}

function optionalMetadata(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = input.metadata;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native tool input metadata is invalid.');
  }
  return value as Record<string, unknown>;
}

function optionalTaskIds(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
  ) {
    throw new Error(`Native tool input ${key} is invalid.`);
  }
  return [...new Set(value as string[])];
}

export class HostedNativeTaskStore {
  private readonly tasks = new Map<string, HostedPlanningTask>();

  constructor(private readonly generateId: () => string) {}

  create(
    ownerId: number,
    turnBindingToken: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    let id = '';
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.generateId();
      if (candidate && candidate.length <= 256 && !this.tasks.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error('Could not allocate a unique planning task ID.');
    const subject = requiredString(input, 'subject', 256);
    const task: HostedPlanningTask = {
      id,
      ownerId,
      turnBindingToken,
      subject,
      description: requiredString(input, 'description', 16 * 1024),
      activeForm: optionalString(input, 'activeForm', 256) ?? subject,
      status: 'pending',
      metadata: Object.assign(
        Object.create(null) as Record<string, unknown>,
        optionalMetadata(input)
      ),
      blocks: new Set(),
      blockedBy: new Set(),
    };
    this.tasks.set(id, task);
    return { task: { id, subject } };
  }

  get(
    ownerId: number,
    turnBindingToken: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const task = this.requireOwnedTask(
      ownerId,
      turnBindingToken,
      requiredString(input, 'taskId', 256)
    );
    return {
      task: {
        id: task.id,
        subject: task.subject,
        description: task.description,
        activeForm: task.activeForm,
        status: task.status,
        ...(task.owner ? { owner: task.owner } : {}),
        blocks: [...task.blocks],
        blockedBy: [...task.blockedBy],
      },
    };
  }

  list(ownerId: number, turnBindingToken: string): Record<string, unknown> {
    return {
      tasks: [...this.tasks.values()]
        .filter((task) => task.ownerId === ownerId && task.turnBindingToken === turnBindingToken)
        .map((task) => ({
          id: task.id,
          subject: task.subject,
          status: task.status,
          ...(task.owner ? { owner: task.owner } : {}),
          blockedBy: [...task.blockedBy],
        })),
    };
  }

  update(
    ownerId: number,
    turnBindingToken: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const taskId = requiredString(input, 'taskId', 256);
    const task = this.requireOwnedTask(ownerId, turnBindingToken, taskId);
    const updatedFields: string[] = [];
    const oldStatus = task.status;
    const status = input.status;
    if (
      status !== undefined &&
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed' &&
      status !== 'deleted'
    ) {
      throw new Error('Native tool input status is invalid.');
    }

    const subject = optionalString(input, 'subject', 256);
    if (subject !== undefined && subject.trim().length === 0) {
      throw new Error('Native tool input subject is invalid.');
    }
    const description = optionalString(input, 'description', 16 * 1024);
    const activeForm = optionalString(input, 'activeForm', 256);
    const owner = optionalString(input, 'owner', 256);
    const metadata = optionalMetadata(input);
    const addBlocks = optionalTaskIds(input, 'addBlocks');
    const addBlockedBy = optionalTaskIds(input, 'addBlockedBy');
    const blockedTasks = addBlocks.map((blockedId) => {
      if (blockedId === taskId) throw new Error('A planning task cannot block itself.');
      return this.requireOwnedTask(ownerId, turnBindingToken, blockedId);
    });
    const blockerTasks = addBlockedBy.map((blockerId) => {
      if (blockerId === taskId) throw new Error('A planning task cannot block itself.');
      return this.requireOwnedTask(ownerId, turnBindingToken, blockerId);
    });

    if (subject !== undefined) {
      task.subject = subject;
      updatedFields.push('subject');
    }
    if (description !== undefined) {
      task.description = description;
      updatedFields.push('description');
    }
    if (activeForm !== undefined) {
      task.activeForm = activeForm;
      updatedFields.push('activeForm');
    }
    if (owner !== undefined) {
      task.owner = owner || undefined;
      updatedFields.push('owner');
    }
    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        if (value === null) delete task.metadata[key];
        else task.metadata[key] = value;
      }
      updatedFields.push('metadata');
    }

    for (const [index, blockedId] of addBlocks.entries()) {
      const blocked = blockedTasks[index];
      task.blocks.add(blockedId);
      blocked.blockedBy.add(taskId);
    }
    if (addBlocks.length > 0) updatedFields.push('blocks');
    for (const [index, blockerId] of addBlockedBy.entries()) {
      const blocker = blockerTasks[index];
      task.blockedBy.add(blockerId);
      blocker.blocks.add(taskId);
    }
    if (addBlockedBy.length > 0) updatedFields.push('blockedBy');

    if (status === 'deleted') {
      this.deleteTask(task);
      updatedFields.push('status');
    } else if (status !== undefined && status !== task.status) {
      task.status = status;
      updatedFields.push('status');
    }
    return {
      success: true,
      taskId,
      updatedFields,
      ...(status && status !== oldStatus ? { statusChange: { from: oldStatus, to: status } } : {}),
    };
  }

  clearOwner(ownerId: number): void {
    for (const task of [...this.tasks.values()]) {
      if (task.ownerId === ownerId) this.deleteTask(task);
    }
  }

  clearTurnBinding(turnBindingToken: string): void {
    for (const task of [...this.tasks.values()]) {
      if (task.turnBindingToken === turnBindingToken) this.deleteTask(task);
    }
  }

  private requireOwnedTask(
    ownerId: number,
    turnBindingToken: string,
    taskId: string
  ): HostedPlanningTask {
    const task = this.tasks.get(taskId);
    if (!task || task.ownerId !== ownerId || task.turnBindingToken !== turnBindingToken) {
      throw new Error('The planning task was not found for this AI turn.');
    }
    return task;
  }

  private deleteTask(task: HostedPlanningTask): void {
    this.tasks.delete(task.id);
    for (const other of this.tasks.values()) {
      other.blocks.delete(task.id);
      other.blockedBy.delete(task.id);
    }
  }
}
