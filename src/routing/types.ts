export interface HeuristicAction {
  action: 'rerank' | 'trace-detail' | 'deny';
  targetTag?: string;
  detail?: 'low' | 'high';
  reason?: string;
}
