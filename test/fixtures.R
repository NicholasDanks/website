suppressMessages(library(seminr))
set.seed(123); cat("SAMPLE_NOREPLACE_344:", paste(head(sample(344, 344, replace = FALSE), 12), collapse=" "), "\n")
set.seed(123); cat("SAMPLE_NOREPLACE_10:", paste(sample(10, 10, replace = FALSE), collapse=" "), "\n")
d <- read.csv("public/seminr-demo/corp_rep_data.csv")
mm <- constructs(
  composite("QUAL", multi_items("qual_", 1:8), weights = mode_B),
  composite("PERF", multi_items("perf_", 1:5), weights = mode_B),
  composite("CSOR", multi_items("csor_", 1:5), weights = mode_B),
  composite("ATTR", multi_items("attr_", 1:3), weights = mode_B),
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("CUSL", multi_items("cusl_", 1:3)))
sm <- relationships(
  paths(from = c("QUAL","PERF","CSOR","ATTR"), to = c("COMP","LIKE")),
  paths(from = c("COMP","LIKE"), to = c("CUSA","CUSL")),
  paths(from = "CUSA", to = "CUSL"))
m <- estimate_pls(d, mm, sm, missing = mean_replacement, missing_value = "-99")
s <- summary(m)
w <- function(name, x) { x <- as.matrix(x); cat(name, "\n"); for (i in seq_len(nrow(x))) cat(rownames(x)[i], "|", paste(sprintf("%.15g", x[i,]), collapse="|"), "\n"); cat("END\n") }
w("PATHS", s$paths)
w("RELIABILITY", s$reliability)
w("HTMT", s$validity$htmt)
w("FSQUARE", s$fSquare)
w("VIF_ANTECEDENTS_CUSL", as.matrix(s$vif_antecedents$CUSL))
set.seed(123)
p <- predict_pls(m, technique = predict_DA, noFolds = 10)
ps <- summary(p)
w("PLS_OOS", ps$PLS_out_of_sample)
w("LM_OOS", ps$LM_out_of_sample)
w("PLS_IS", ps$PLS_in_sample)
