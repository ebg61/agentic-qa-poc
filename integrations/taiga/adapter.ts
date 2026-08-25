/**
 * Taiga board adapter.
 *
 * QA work is triggered by Tasks in Ready for QA. The parent User Story
 * is the requirement. Writes are limited to Task status transitions and
 * Task comments after the QA Reviewer decision. No attachments.
 *
 * Agents must not import this module; only the Orchestrator should.
 */

import type {
  BoardAdapter,
  BoardProject,
  BoardRequirement,
  BoardStatus,
  IntendedWorkflowStatus,
} from "../board.js";
import { INTENDED_WORKFLOW_STATUSES } from "../board.js";
import {
  createTaigaClientFromEnv,
  type TaigaClient,
} from "./client.js";
import type {
  TaigaProject,
  TaigaTask,
  TaigaTaskStatus,
  TaigaUserStory,
} from "./types.js";

const DEFAULT_PROJECT_SLUG = "erikatest-poc";
const EXPLICIT_REQUIREMENT_ID = /\bUS-\d+\b/i;

/**
 * Taiga task status names → intended Orchestrator workflow names.
 * Matching is by discovered name, never by hardcoded numeric IDs.
 */
const TAIGA_TASK_STATUS_TO_INTENDED: Record<string, IntendedWorkflowStatus> = {
  new: "TO DO",
  "in progress": "IN DEVELOPMENT",
  "ready for qa": "READY FOR QA",
  "pending qa review": "PENDING QA REVIEW",
  "returned by qa": "RETURNED BY QA",
  done: "DONE",
};

export function createTaigaAdapter(options?: {
  client?: TaigaClient;
  projectSlug?: string;
}): BoardAdapter {
  const client = options?.client ?? createTaigaClientFromEnv();
  const projectSlug = (
    options?.projectSlug ??
    process.env.TAIGA_PROJECT_SLUG?.trim() ??
    DEFAULT_PROJECT_SLUG
  ).trim();

  if (!projectSlug) {
    throw new Error("Taiga project slug must be a non-empty string");
  }

  return new TaigaBoardAdapter(client, projectSlug);
}

class TaigaBoardAdapter implements BoardAdapter {
  private projectCache: BoardProject | undefined;

  constructor(
    private readonly client: TaigaClient,
    private readonly projectSlug: string
  ) {}

  async getProject(): Promise<BoardProject> {
    if (this.projectCache) {
      return this.projectCache;
    }

    const project = await this.client.getJson<TaigaProject>(
      `/projects/by_slug?slug=${encodeURIComponent(this.projectSlug)}`
    );

    this.projectCache = {
      id: String(project.id),
      name: project.name,
      slug: project.slug,
    };

    return this.projectCache;
  }

  async getStatuses(): Promise<BoardStatus[]> {
    const project = await this.getProject();
    const statuses = await this.client.getJsonList<TaigaTaskStatus>(
      `/task-statuses?project=${encodeURIComponent(project.id)}`
    );

    return statuses
      .slice()
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map((status) => ({
        id: String(status.id),
        name: status.name,
        intendedName: matchIntendedStatus(status.name),
      }));
  }

  async getReadyForQA(): Promise<BoardRequirement[]> {
    const project = await this.getProject();
    const ready = await this.findReadyForQAStatus();

    if (!ready) {
      return [];
    }

    const tasks = await this.client.getJsonList<TaigaTask>(
      `/tasks?project=${encodeURIComponent(project.id)}&status=${encodeURIComponent(ready.id)}`
    );

    const requirements: BoardRequirement[] = [];

    for (const task of tasks) {
      const requirement = await this.requirementFromReadyTask(task, project);
      if (requirement) {
        requirements.push(requirement);
      }
    }

    return requirements;
  }

  async setTaskStatus(
    boardTaskId: string,
    intendedStatus: IntendedWorkflowStatus
  ): Promise<BoardStatus> {
    const taskId = boardTaskId.trim();
    if (!taskId) {
      throw new Error("boardTaskId must be a non-empty string");
    }

    const statuses = await this.getStatuses();
    const target = statuses.find(
      (status) => status.intendedName === intendedStatus
    );
    if (!target) {
      throw new Error(
        `Taiga task status "${intendedStatus}" was not found. No status was created or renamed.`
      );
    }

    const task = await this.client.getJson<TaigaTask>(
      `/tasks/${encodeURIComponent(taskId)}`
    );

    if (String(task.status) === target.id) {
      return target;
    }

    if (typeof task.version !== "number") {
      throw new Error(
        `Taiga task ${taskId} has no version; cannot update status.`
      );
    }

    await this.client.patchJson<TaigaTask>(
      `/tasks/${encodeURIComponent(taskId)}`,
      {
        status: Number(target.id),
        version: task.version,
      }
    );

    return target;
  }

  async addTaskComment(boardTaskId: string, comment: string): Promise<void> {
    const taskId = boardTaskId.trim();
    const text = comment.trim();
    if (!taskId) {
      throw new Error("boardTaskId must be a non-empty string");
    }
    if (!text) {
      throw new Error("Task comment must be a non-empty string");
    }

    const task = await this.client.getJson<TaigaTask>(
      `/tasks/${encodeURIComponent(taskId)}`
    );
    if (typeof task.version !== "number") {
      throw new Error(
        `Taiga task ${taskId} has no version; cannot add a comment.`
      );
    }

    await this.client.patchJson<TaigaTask>(
      `/tasks/${encodeURIComponent(taskId)}`,
      {
        comment: text,
        version: task.version,
      }
    );
  }

  async getRequirement(requirementId: string): Promise<BoardRequirement> {
    const requested = requirementId.trim();
    if (!requested) {
      throw new Error("requirementId must be a non-empty string");
    }

    const project = await this.getProject();
    const story = await this.findUserStory(project, requested);
    const task = await this.findTaskForStory(project, story.id);

    if (!task) {
      throw new Error(
        `User story ${story.id} has no Taiga Task to use as the QA workflow trigger`
      );
    }

    return toBoardRequirement(task, story, project);
  }

  private async findReadyForQAStatus(): Promise<BoardStatus | undefined> {
    const statuses = await this.getStatuses();
    return statuses.find((status) => status.intendedName === "READY FOR QA");
  }

  private async requirementFromReadyTask(
    task: TaigaTask,
    project: BoardProject
  ): Promise<BoardRequirement | undefined> {
    const userStoryId = task.user_story;
    if (userStoryId == null) {
      console.log(
        `Skipping Taiga task ${task.id}: no parent User Story.`
      );
      return undefined;
    }

    const story = await this.client.getJson<TaigaUserStory>(
      `/userstories/${encodeURIComponent(String(userStoryId))}`
    );

    return toBoardRequirement(task, story, project);
  }

  private async findUserStory(
    project: BoardProject,
    requested: string
  ): Promise<TaigaUserStory> {
    if (/^\d+$/.test(requested)) {
      return this.client.getJson<TaigaUserStory>(
        `/userstories/${encodeURIComponent(requested)}`
      );
    }

    const stories = await this.client.getJsonList<TaigaUserStory>(
      `/userstories?project=${encodeURIComponent(project.id)}`
    );

    const match = stories.find((story) => {
      const explicitId = extractExplicitRequirementId(
        story.subject,
        story.description
      );
      return explicitId?.toUpperCase() === requested.toUpperCase();
    });

    if (!match) {
      throw new Error(
        `No Taiga user story found for requirement "${requested}" in project ${project.slug}`
      );
    }

    return match;
  }

  private async findTaskForStory(
    project: BoardProject,
    userStoryId: number
  ): Promise<TaigaTask | undefined> {
    const tasks = await this.client.getJsonList<TaigaTask>(
      `/tasks?project=${encodeURIComponent(project.id)}&user_story=${encodeURIComponent(String(userStoryId))}`
    );

    return tasks[0];
  }
}

function toBoardRequirement(
  task: TaigaTask,
  story: TaigaUserStory,
  project: BoardProject
): BoardRequirement {
  const taskTitle = task.subject?.trim() || "(untitled task)";
  const storyTitle = story.subject?.trim() || "(untitled user story)";
  const storyDescription = story.description?.trim() || undefined;

  return {
    requirementId: extractExplicitRequirementId(
      taskTitle,
      `${storyTitle}\n${storyDescription ?? ""}`
    ),
    source: "taiga",
    sourceId: String(story.id),
    title: storyTitle,
    description: storyDescription,
    projectId: String(story.project ?? task.project ?? project.id),
    projectName:
      story.project_extra_info?.name?.trim() ||
      task.project_extra_info?.name?.trim() ||
      project.name,
    boardTaskId: String(task.id),
    boardTaskTitle: taskTitle,
    boardTaskStatusId: String(task.status),
    boardTaskStatusName:
      task.status_extra_info?.name?.trim() || String(task.status),
  };
}

export function extractExplicitRequirementId(
  title: string,
  description?: string | null
): string | undefined {
  const fromTitle = title.match(EXPLICIT_REQUIREMENT_ID)?.[0];
  if (fromTitle) {
    return normalizeRequirementId(fromTitle);
  }

  const fromDescription = description?.match(EXPLICIT_REQUIREMENT_ID)?.[0];
  if (fromDescription) {
    return normalizeRequirementId(fromDescription);
  }

  return undefined;
}

export function matchIntendedStatus(name: string): string | undefined {
  const normalized = normalizeStatusName(name);
  const mapped = TAIGA_TASK_STATUS_TO_INTENDED[normalized];
  if (mapped) {
    return mapped;
  }

  return INTENDED_WORKFLOW_STATUSES.find(
    (intended) => normalizeStatusName(intended) === normalized
  );
}

function normalizeRequirementId(value: string): string {
  const match = value.match(/^us-(\d+)$/i);
  if (!match) {
    return value;
  }
  return `US-${match[1]}`;
}

function normalizeStatusName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}
