export interface YammerNetwork {
  readonly id: number;
  readonly name: string;
  readonly permalink: string;
}

export interface YammerGroup {
  readonly id: number;
  readonly full_name: string;
  readonly network_id: number;
  readonly description?: string;
}

export interface YammerUser {
  readonly id: number;
  readonly full_name?: string;
  readonly email?: string;
}

export interface YammerMessageBody {
  readonly plain?: string;
  readonly rich?: string;
}

export interface YammerMessage {
  readonly id: number;
  readonly thread_id: number;
  readonly sender_id: number;
  readonly created_at: string;
  readonly body: YammerMessageBody;
  readonly group_id?: number;
}

export interface YammerMessagesResponse {
  readonly messages: readonly YammerMessage[];
  readonly references: readonly Array<
    | ({ readonly type: "user" } & YammerUser)
    | { readonly type: string; readonly id: number }
  >;
  readonly threaded_extended?: Record<string, readonly number[]>;
}
