/**
 * Generic board contract.
 *
 * Agents must depend on this shape, not on Taiga (or any other board) APIs.
 * The Orchestrator chooses the adapter and decides which requirements need QA.
 *
 * For this PoC, a board Task in READY FOR QA is the trigger, and its
 * parent User Story is the requirement. One Task per User Story.
 */

export interface BoardProject {
  id: string;
  name: string;
  slug: string;
}

export interface BoardStatus {
  id: string;
  name: string;
  /**
   * Matching intended workflow name, if any.
   * Never renamed; unmatched statuses stay undefined.
   */
  intendedName?: string;
}

export interface BoardRequirement {
  requirementId?: string;
  source: "taiga";
  sourceId: string;
  title: string;
  description?: string;
  projectId: string;
  projectName: string;
  boardTaskId: string;
  boardTaskTitle: string;
  boardTaskStatusId: string;
  boardTaskStatusName: string;
}

export interface BoardAdapter {
  getProject(): Promise<BoardProject>;
  getStatuses(): Promise<BoardStatus[]>;
  getReadyForQA(): Promise<BoardRequirement[]>;
  getRequirement(requirementId: string): Promise<BoardRequirement>;
  setTaskStatus(
    boardTaskId: string,
    intendedStatus: IntendedWorkflowStatus
  ): Promise<BoardStatus>;
  addTaskComment(boardTaskId: string, comment: string): Promise<void>;
}

export const INTENDED_WORKFLOW_STATUSES = [
  "TO DO",
  "IN DEVELOPMENT",
  "READY FOR QA",
  "PENDING QA REVIEW",
  "RETURNED BY QA",
  "DONE",
] as const;

export type IntendedWorkflowStatus =
  (typeof INTENDED_WORKFLOW_STATUSES)[number];
