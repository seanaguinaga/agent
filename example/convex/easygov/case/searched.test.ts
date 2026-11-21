import { expect, test } from "vitest";
import { pagesSearched } from "./research";

test("pagesSearched reads the search's own page list, not the model's text", () => {
  const result = {
    sources: [{ sourceType: "url", url: "https://a.gov/one" }],
    response: {
      body: {
        choices: [
          {
            message: {
              // A URL the model wrote in its answer is not a page it read.
              content: '{"url":"https://invented.gov/form.pdf"}',
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://a.gov/two" },
                },
                {
                  type: "url_citation",
                  url_citation: { url: "https://a.gov/one" },
                },
              ],
            },
          },
        ],
      },
    },
  };
  expect(pagesSearched(result)).toEqual([
    "https://a.gov/one",
    "https://a.gov/two",
  ]);
  expect(pagesSearched({})).toEqual([]);
});
