export interface TimelineEntry {
  year: string;
  title: string;
  organization: string;
  type: "position" | "education" | "achievement";
}

/** CV timeline, most recent first within each type. */
export const timeline: TimelineEntry[] = [
  { year: "Feb 2023 – Present", title: "Associate Professor of Business Analytics", organization: "Trinity Business School, Trinity College Dublin", type: "position" },
  { year: "Sep 2024 – Present", title: "Program Director, MSc Business Analytics", organization: "Trinity Business School, Trinity College Dublin", type: "position" },
  { year: "Jun 2022 – Present", title: "Associate Director, Centre for Digital Business Analytics (CDBA)", organization: "Trinity Business School, Trinity College Dublin", type: "position" },
  { year: "Aug 2020 – Jan 2023", title: "Assistant Professor of Business Analytics", organization: "Trinity Business School, Trinity College Dublin", type: "position" },
  { year: "Oct 2019 – Dec 2019", title: "Visiting Lecturer", organization: "Otto-von-Guericke University, Magdeburg, Germany", type: "position" },
  { year: "Sep 2017 – Sep 2019", title: "Educator", organization: "National Tsing Hua University, Taiwan", type: "position" },
  { year: "2024", title: "Published 'The Composite Overfit Analysis Framework' in Management Science", organization: "Management Science (ABS4*/FT50/UTD)", type: "achievement" },
  { year: "2021", title: "PLS-SEM Using R Workbook Published", organization: "Springer — Hair, Hult, Ringle, Sarstedt, Danks, Ray", type: "achievement" },
  { year: "2018", title: "SEMinR Released on CRAN", organization: "Co-created with Soumya Ray — R package for PLS-SEM", type: "achievement" },
  { year: "2020", title: "PhD in Service Science (Business Analytics and Service Science)", organization: "National Tsing Hua University, Taiwan", type: "education" },
  { year: "2016", title: "MBA (Business Administration)", organization: "National Tsing Hua University, Taiwan", type: "education" },
  { year: "2008", title: "Bachelor of Accounting Science (B. Compt.)", organization: "University of South Africa", type: "education" },
];
