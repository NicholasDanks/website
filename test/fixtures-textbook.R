# Textbook v2 (Hair et al. 2026) chapter-4/5/8 quantities for test/seminr-parity.mjs.
suppressMessages({library(seminr); library(seminrExtras)})
d <- read.csv("public/seminr-demo/corp_rep_data.csv")
mm <- constructs(composite("QUAL", multi_items("qual_", 1:8), weights = mode_B), composite("PERF", multi_items("perf_", 1:5), weights = mode_B),
  composite("CSOR", multi_items("csor_", 1:5), weights = mode_B), composite("ATTR", multi_items("attr_", 1:3), weights = mode_B),
  composite("COMP", multi_items("comp_", 1:3)), composite("LIKE", multi_items("like_", 1:3)), composite("CUSA", single_item("cusa")), composite("CUSL", multi_items("cusl_", 1:3)))
sm <- relationships(paths(from = c("QUAL","PERF","CSOR","ATTR"), to = c("COMP","LIKE")), paths(from = c("COMP","LIKE"), to = c("CUSA","CUSL")), paths(from = "CUSA", to = "CUSL"))
m <- estimate_pls(d, mm, sm, missing = mean_replacement, missing_value = "-99"); s <- summary(m)
cat("UPSILON_LIKE", sprintf("%.15g", s$paths["LIKE","CUSA"]^2 * s$paths["CUSA","CUSL"]^2), "\n")
cat("UPSILON_COMP", sprintf("%.15g", s$paths["COMP","CUSA"]^2 * s$paths["CUSA","CUSL"]^2), "\n")
for (c in c("QUAL","PERF","CSOR","ATTR")) {
  stub <- tolower(c); items <- grep(paste0("^", stub, "_[0-9]+$"), names(d), value = TRUE)
  rmm <- constructs(composite(paste0(c,"_F"), items, weights = mode_B), composite(paste0(c,"_G"), single_item(paste0(stub,"_global"))))
  rsm <- relationships(paths(from = paste0(c,"_F"), to = paste0(c,"_G")))
  rm_ <- estimate_pls(d, rmm, rsm, missing = mean_replacement, missing_value = "-99")
  cat("REDUNDANCY", c, sprintf("%.15g", summary(rm_)$paths[paste0(c,"_F"), paste0(c,"_G")]), "\n")
}
dim_data <- m$data
for (c in c("COMP","LIKE","CUSL")) {
  items <- grep(paste0("^", tolower(c), "_[0-9]+$"), names(d), value = TRUE)
  ev <- base::eigen(cor(dim_data[, items]))$values
  cat("EIGEN", c, paste(sprintf("%.12g", ev), collapse = " "), "\n")
}
