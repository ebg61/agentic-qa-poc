/**
 * Minimal Taiga API response shapes used by the read-only client.
 */

export interface TaigaProject {
  id: number;
  name: string;
  slug: string;
}

export interface TaigaTaskStatus {
  id: number;
  name: string;
  order?: number;
  is_closed?: boolean;
  project?: number;
}

export interface TaigaTask {
  id: number;
  ref?: number;
  subject: string;
  description?: string | null;
  version?: number;
  status: number;
  status_extra_info?: {
    name?: string;
    is_closed?: boolean;
  } | null;
  user_story: number | null;
  user_story_extra_info?: {
    id?: number;
    ref?: number;
    subject?: string;
  } | null;
  project: number;
  project_extra_info?: {
    id?: number;
    name?: string;
    slug?: string;
  } | null;
}

export interface TaigaUserStory {
  id: number;
  ref?: number;
  subject: string;
  description?: string | null;
  status: number;
  status_extra_info?: {
    name?: string;
    is_closed?: boolean;
  } | null;
  project: number;
  project_extra_info?: {
    id?: number;
    name?: string;
    slug?: string;
  } | null;
}
