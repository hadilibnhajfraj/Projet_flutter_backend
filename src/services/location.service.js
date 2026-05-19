// services/location.service.js
const { Op, literal } = require('sequelize');

/**
 * Location Service - Handles geographic operations for projects
 */
class LocationService {
  /**
   * Validates latitude and longitude coordinates
   * @param {number} lat - Latitude (-90 to 90)
   * @param {number} lng - Longitude (-180 to 180)
   * @returns {boolean} True if valid
   */
  static validateCoordinates(lat, lng) {
    const latitude = Number(lat);
    const longitude = Number(lng);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return false;
    }

    return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  }

  /**
   * Normalizes coordinate input from various formats
   * @param {Object} body - Request body
   * @returns {Object} Normalized coordinates {lat, lng}
   */
  static normalizeCoordinates(body = {}) {
    // Support multiple input formats
    let lat = null;
    let lng = null;

    if (body.latitude !== undefined) lat = body.latitude;
    if (body.longitude !== undefined) lng = body.longitude;

    if (body.lng !== undefined && lng === null) lng = body.lng;
    if (body.lat !== undefined && lat === null) lat = body.lat;

    if (body.location) {
      if (body.location.lat !== undefined && lat === null) lat = body.location.lat;
      if (body.location.lng !== undefined && lng === null) lng = body.location.lng;
      if (body.location.latitude !== undefined && lat === null) lat = body.location.latitude;
      if (body.location.longitude !== undefined && lng === null) lng = body.location.longitude;
      if (body.location.lon !== undefined && lng === null) lng = body.location.lon;
    }

    const numLat = lat !== null && lat !== undefined ? Number(lat) : null;
    const numLng = lng !== null && lng !== undefined ? Number(lng) : null;
    const hasCoordinates = numLat !== null || numLng !== null;
    const valid = Number.isFinite(numLat) && Number.isFinite(numLng) && this.validateCoordinates(numLat, numLng);

    return {
      lat: Number.isFinite(numLat) ? numLat : null,
      lng: Number.isFinite(numLng) ? numLng : null,
      valid,
      hasCoordinates,
    };
  }

  /**
   * Calculates distance between two coordinates using Haversine formula
   * @param {number} lat1 - Latitude 1
   * @param {number} lng1 - Longitude 1
   * @param {number} lat2 - Latitude 2
   * @param {number} lng2 - Longitude 2
   * @returns {number} Distance in kilometers
   */
  static calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLng = this.toRadians(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Converts degrees to radians
   * @param {number} degrees
   * @returns {number} Radians
   */
  static toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }

  /**
   * Generates a localization comment if empty
   * @param {number} lat - Latitude
   * @param {number} lng - Longitude
   * @param {string} existingComment - Existing comment
   * @returns {string} Generated or existing comment
   */
  static generateLocalizationComment(lat, lng, existingComment) {
    if (existingComment && existingComment.trim()) {
      return existingComment.trim();
    }

    if (lat !== null && lng !== null) {
      // Round to 4 decimal places for readability
      const roundedLat = Math.round(lat * 10000) / 10000;
      const roundedLng = Math.round(lng * 10000) / 10000;
      return `Coordinates: ${roundedLat}, ${roundedLng}`;
    }

    return null;
  }

  /**
   * Finds nearby projects within a specified radius
   * @param {number} centerLat - Center latitude
   * @param {number} centerLng - Center longitude
   * @param {number} radiusKm - Search radius in kilometers (default: 50)
   * @param {number} limit - Maximum results (default: 50)
   * @param {Array|null} accessibleProjectIds - Optional project IDs to restrict search
   * @returns {Promise<Array>} Array of projects with distance
   */
  static async findNearbyProjects(centerLat, centerLng, radiusKm = 50, limit = 50, accessibleProjectIds = null) {
    const { Project } = require('../models/associations');

    if (!this.validateCoordinates(centerLat, centerLng)) {
      throw new Error('Invalid center coordinates');
    }

    if (accessibleProjectIds !== null && !Array.isArray(accessibleProjectIds)) {
      throw new Error('accessibleProjectIds must be an array or null');
    }

    if (Array.isArray(accessibleProjectIds) && accessibleProjectIds.length === 0) {
      return [];
    }

    const lat = Number(centerLat);
    const lng = Number(centerLng);
    const boundingLat = radiusKm / 111.32;
    const boundingLng = radiusKm / (111.32 * Math.cos(this.toRadians(lat)) || 1);

    const distanceExpression = literal(`
      6371 * 2 * asin(
        sqrt(
          power(sin(radians("latitude" - ${lat}) / 2), 2) +
          cos(radians(${lat})) * cos(radians("latitude")) *
          power(sin(radians("longitude" - ${lng}) / 2), 2)
        )
      )
    `);

    const where = {
      latitude: { [Op.between]: [lat - boundingLat, lat + boundingLat] },
      longitude: { [Op.between]: [lng - boundingLng, lng + boundingLng] },
      isArchived: false,
    };

    if (accessibleProjectIds !== null) {
      where.id = { [Op.in]: accessibleProjectIds };
    }

    const rows = await Project.findAll({
      where,
      attributes: [
        'id',
        'nomProjet',
        'latitude',
        'longitude',
        'localisationCommentaire',
        'statut',
        'typeAdresseChantier',
        'entreprise',
        'dateDemarrage',
        [distanceExpression, 'distanceKm'],
      ],
      order: [[distanceExpression, 'ASC']],
      limit,
      raw: true,
    });

    return rows
      .map((row) => ({
        ...row,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        distanceKm: Number(Number(row.distanceKm).toFixed(2)),
      }))
      .filter((row) => row.distanceKm <= radiusKm);
  }

  /**
   * Formats project data for map integration
   * @param {Object} project - Project instance
   * @returns {Object} Map-ready project data
   */
  static formatForMap(project) {
    return {
      id: project.id,
      nomProjet: project.nomProjet,
      position: {
        lat: parseFloat(project.latitude),
        lng: parseFloat(project.longitude)
      },
      localisationCommentaire: project.localisationCommentaire,
      statut: project.statut,
      typeAdresseChantier: project.typeAdresseChantier,
      entreprise: project.entreprise,
      dateDemarrage: project.dateDemarrage,
      distanceKm: project.distanceKm || null
    };
  }

  /**
   * Validates coordinate input with detailed error messages
   * @param {Object} body - Request body
   * @param {boolean} isRequired - Whether coordinates are required
   * @returns {Array} Array of validation errors
   */
  static validateCoordinateInput(body, isRequired = false) {
    const errors = [];
    const coords = this.normalizeCoordinates(body);
    const hasLat = coords.lat !== null;
    const hasLng = coords.lng !== null;

    if (isRequired && (!hasLat || !hasLng)) {
      errors.push('Coordinates are required (latitude and longitude)');
      return errors;
    }

    if (hasLat || hasLng) {
      if (!hasLat) {
        errors.push('Latitude is required when providing coordinates');
      }
      if (!hasLng) {
        errors.push('Longitude is required when providing coordinates');
      }

      if (hasLat && !Number.isFinite(coords.lat)) {
        errors.push('Latitude must be a number');
      } else if (hasLat && (coords.lat < -90 || coords.lat > 90)) {
        errors.push('Latitude must be between -90 and 90 degrees');
      }

      if (hasLng && !Number.isFinite(coords.lng)) {
        errors.push('Longitude must be a number');
      } else if (hasLng && (coords.lng < -180 || coords.lng > 180)) {
        errors.push('Longitude must be between -180 and 180 degrees');
      }
    }

    return errors;
  }
}

module.exports = LocationService;