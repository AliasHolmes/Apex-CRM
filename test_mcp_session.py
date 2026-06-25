"""
Quick smoke test for the LinkedIn MCP session.
Runs mcp-server-linkedin as a subprocess and calls get_person_profile
on a known public profile to verify the cookies are working.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


PROFILE_PATH = Path(__file__).parent / ".apex-data" / "linkedin-profile"
TEST_USERNAME = "williamhgates"  # Bill Gates - always public


async def main():
    print(f"[test] Using profile: {PROFILE_PATH}")
    print(f"[test] Testing MCP get_person_profile for: {TEST_USERNAME}")

    server_params = StdioServerParameters(
        command="mcp-server-linkedin",
        args=["--user-data-dir", str(PROFILE_PATH)],
        env={**os.environ},
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print("[test] OK: MCP server connected and initialized")

            print(f"[test] Calling get_person_profile({TEST_USERNAME})...")
            result = await session.call_tool(
                "get_person_profile",
                arguments={
                    "linkedin_username": TEST_USERNAME,
                    "sections": "experience",
                },
            )

            if result and result.content:
                text = result.content[0].text if result.content else ""
                print(f"[test] SUCCESS - got {len(text)} chars of profile data")
                print("[test] Preview:")
                print(text[:500])
            else:
                print("[test] FAIL - EMPTY result - session may still be hitting auth wall")
                sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
