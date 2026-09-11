/** Site-wide facts used by more than one page. Edit here, not in the pages. */
export const site = {
  name: "Nicholas P. Danks",
  title: "Associate Professor of Business Analytics",
  institution: "Trinity Business School, Trinity College Dublin",
  bio: "I am an Associate Professor of Business Analytics at Trinity Business School, Trinity College Dublin. My research focuses on the methodology of partial least squares structural equation modeling (PLS-SEM), predictive modeling, and model selection techniques. I am the co-creator and maintainer of the SEMinR R package, which provides a domain-specific language for building and estimating structural equation models in R. I hold a PhD from National Tsing Hua University, Taiwan, and also serve as Program Director for the MSc in Business Analytics.",
  email: "Nicholas.danks@tcd.ie",
  address: ["Trinity Business School", "Trinity College Dublin", "Dublin 2, Ireland"],
  scholar: "https://scholar.google.com/citations?user=D7nnR8gAAAAJ&hl=en",
  github: "https://github.com/NicholasDanks",
  orcid: "https://orcid.org/0000-0002-7521-929X",
  researchInterests: [
    "PLS-SEM Methodology",
    "Predictive Modeling",
    "Model Selection",
    "Information Systems",
    "Statistical Software Development",
    "Business Analytics",
  ],
  /** Google Scholar, June 2026. The total-citation figure is deliberately omitted: Scholar merges the 2021 workbook with the Hair et al. Primer family, inflating it. */
  scholarMetrics: { hIndex: 17, i10Index: 19, asOf: "June 2026" },
} as const;
