import puppeteer from "puppeteer";
import fs from "fs";

async function scrapeNinjaTable(mode) {
    const tableSelector =
        mode === 0
            ? 'table[data-ninja_table_instance="ninja_table_instance_0"]'
            : 'table[data-ninja_table_instance="ninja_table_instance_1"]';

    const indexMap =
        mode === 0
            ? {
                StageNumber: 0,
                StageName: 1,
                StartStage: 2,
                EndStage: 3,
                RouteNumber: 4,
                NumberOfStages: 7,
            }
            : {
                StageNumber: 6,
                StageName: 7,
                StartStage: 4,
                EndStage: 5,
                RouteNumber: 1,
                NumberOfStages: 3,
            }

    const browser = await puppeteer.launch({
        headless: false,       // show browser
        defaultViewport: null, // full screen
        args: ["--start-maximized"] // start in full screen
    });

    const page = await browser.newPage();
    await page.goto("https://www.buscnt.mu/test/", { waitUntil: "networkidle0" });

    let result = [];
    while (true) {
        const { rowData, completed } = await page.evaluate(async (tableSelector, indexMap) => {
            const table = document.querySelector(tableSelector);

            const rowData = [...table.querySelectorAll("tbody tr")].map((tr) => {
                const cells = tr.querySelectorAll("td");

                return Object.entries(indexMap).reduce((acc, [key, index]) => {
                    acc[key] = cells[index].innerText.trim();

                    return acc;
                }, {});
            });

            const nextLi = table.querySelector('li.footable-page-nav[data-page="next"]');
            completed = nextLi.classList.contains("disabled");

            nextLi.querySelector("a.footable-page-link").click();
            await new Promise((resolve) => setTimeout(resolve, 400));

            return { rowData, completed };
        }, tableSelector, indexMap);

        result = [...result, ...rowData];

        if (completed) break;
    }

    await browser.close();

    console.log(`✅ Scraped ${result.length} total rows.`);
    return result;
}

const main = async () => {
    const [result0, result1] = await Promise.all([
        scrapeNinjaTable(0),
        scrapeNinjaTable(1),
    ]);

    fs.writeFileSync("data/routesRAW.json", JSON.stringify([...result0, ...result1], null, 2));
}

main();
