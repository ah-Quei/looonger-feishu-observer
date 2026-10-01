/** 授权向导纯函数件单测。 */
import { describe, expect, test } from "bun:test";
import {
  AUTHORIZE_SCOPES,
  accountsBaseUrl,
  buildAuthorizeUrl,
  parseCallback,
} from "../src/setup-lib";

describe("setup-lib", () => {
  test("授权链接：accounts 域 + response_type=code + scope 空格分隔 + state", () => {
    const url = new URL(
      buildAuthorizeUrl({
        appId: "cli_test",
        redirectUri: "http://localhost:8972/callback",
        scopes: AUTHORIZE_SCOPES,
        state: "st_123",
      }),
    );
    expect(url.origin).toBe("https://accounts.feishu.cn");
    expect(url.pathname).toBe("/open-apis/authen/v1/authorize");
    expect(url.searchParams.get("client_id")).toBe("cli_test");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8972/callback");
    // scope 分隔符：官方文档用 %20（不是 +）
    expect(url.toString()).toContain("scope=im%3Achat%3Areadonly%20im%3Achat.members%3Awrite_only");
    expect(url.searchParams.get("state")).toBe("st_123");
  });

  test("accountsBaseUrl：open ↔ accounts（Lark 国际版同样推导）", () => {
    expect(accountsBaseUrl("https://open.feishu.cn")).toBe("https://accounts.feishu.cn");
    expect(accountsBaseUrl("https://open.larksuite.com")).toBe("https://accounts.larksuite.com");
  });

  test("buildAuthorizeUrl 尊重自定义 baseUrl", () => {
    const url = buildAuthorizeUrl({
      appId: "cli_x",
      redirectUri: "http://localhost:8972/callback",
      scopes: ["im:chat:readonly"],
      state: "s",
      baseUrl: "https://open.larksuite.com",
    });
    expect(url.startsWith("https://accounts.larksuite.com/")).toBe(true);
  });

  test("回调解析：成功 / 拒绝 / state 不匹配 / 缺 code / 非 URL", () => {
    expect(
      parseCallback("http://localhost:8972/callback?code=abc&state=st", "st"),
    ).toEqual({ kind: "code", state: "st", code: "abc" });
    expect(parseCallback("http://localhost:8972/callback?error=access_denied&state=st", "st")).toEqual({
      kind: "denied",
      state: "st",
    });
    // CSRF 防护：state 不匹配一律 invalid（哪怕带 code）
    expect(parseCallback("http://localhost:8972/callback?code=abc&state=other", "st")).toEqual({
      kind: "invalid",
    });
    expect(parseCallback("http://localhost:8972/callback?state=st", "st")).toEqual({ kind: "invalid" });
    expect(parseCallback("not-a-url", "st")).toEqual({ kind: "invalid" });
  });

  test("回调解析：# 片段不影响 query 解析（飞书文档注记的场景）", () => {
    expect(parseCallback("http://localhost:8972/callback?code=abc&state=st#/login", "st")).toEqual({
      kind: "code",
      state: "st",
      code: "abc",
    });
  });
});
