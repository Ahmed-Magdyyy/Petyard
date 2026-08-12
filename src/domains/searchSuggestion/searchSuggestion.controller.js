import asyncHandler from "express-async-handler";
import {
  createSearchSuggestionService,
  deleteSearchSuggestionService,
  getAdminSearchSuggestionsService,
  getSearchSuggestionsService,
  updateSearchSuggestionPositionsService,
  updateSearchSuggestionService,
} from "./searchSuggestion.service.js";

export const getSearchSuggestions = asyncHandler(async (req, res) => {
  const result = await getSearchSuggestionsService({
    ...req.query,
    lang: req.lang,
  });
  res.status(200).json(result);
});

export const getAdminSearchSuggestions = asyncHandler(async (req, res) => {
  const result = await getAdminSearchSuggestionsService({
    ...req.query,
    lang: req.lang,
  });
  res.status(200).json(result);
});

export const createSearchSuggestion = asyncHandler(async (req, res) => {
  const data = await createSearchSuggestionService(req.body, req.lang);
  res.status(201).json({ data });
});

export const updateSearchSuggestionPositions = asyncHandler(async (req, res) => {
  const data = await updateSearchSuggestionPositionsService(req.body.positions);
  res.status(200).json({ data });
});

export const updateSearchSuggestion = asyncHandler(async (req, res) => {
  const data = await updateSearchSuggestionService(
    req.params.id,
    req.body,
    req.lang,
  );
  res.status(200).json({ data });
});

export const deleteSearchSuggestion = asyncHandler(async (req, res) => {
  await deleteSearchSuggestionService(req.params.id);
  res.status(200).json({ message: "Search suggestion deleted successfully" });
});
