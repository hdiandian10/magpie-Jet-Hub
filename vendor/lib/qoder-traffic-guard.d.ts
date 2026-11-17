export type QoderTrafficProvider = 'qoder' | 'qodercn';
/** 未在面板设置时的默认值。 */
export declare function qoderTrafficGuardEnabled(): boolean;
/** 预留整个流的并发名额。账号忙时直接报告本地排队，避免积压请求。 */
export declare function acquireQoderRequest(provider: string, uid: string, signal?: AbortSignal): Promise<Disposable>;
//# sourceMappingURL=qoder-traffic-guard.d.ts.map