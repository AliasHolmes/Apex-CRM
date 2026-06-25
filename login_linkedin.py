import asyncio
from patchright.async_api import async_playwright
import os

async def main():
    profile_path = os.path.join(os.getcwd(), '.apex-data', 'linkedin-profile')
    print(f"Launching Patchright with profile: {profile_path}")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch_persistent_context(
            user_data_dir=profile_path,
            headless=False,
            no_viewport=True,
        )
        
        page = browser.pages[0] if browser.pages else await browser.new_page()
        print("Navigating to LinkedIn... Please log in.")
        await page.goto('https://www.linkedin.com/login')
        
        print("\n*** WAITING FOR LOGIN ***")
        print("Please log in to your LinkedIn account in the browser window that just opened.")
        print("Once you are fully logged in and see your feed, CLOSE THE BROWSER WINDOW to save the session.")
        
        try:
            # Wait until the user manually closes the page/browser
            while not page.is_closed():
                await asyncio.sleep(1)
        except Exception:
            pass
            
        print("Browser closed. Session saved!")

if __name__ == "__main__":
    asyncio.run(main())
